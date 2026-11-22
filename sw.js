// FrankShift service worker: push notifications only (no offline cache, so staff always get the latest version).
// The phone plays its own notification sound; FrankShift's in-app tones play while the app is open.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// The app saves the language the person picked, so alerts come in that language.
async function lang(){
  try { const r = await (await caches.open('fs-pref')).match('fs-lang'); const v = r ? (await r.text()).trim() : ''; if (v === 'es' || v === 'en') return v; } catch {}
  return /^es\b/i.test((self.navigator && self.navigator.language) || '') ? 'es' : 'en';
}
// Each kind feels different in the pocket: order = two short taps, urgent = fast long buzzing, alarm = three long buzzes,
// maintenance (engineering) = three knocks and a long buzz.
const VIBE = { order: [150, 100, 150], urgent: [300, 100, 300, 100, 300, 100, 300, 100, 700], alarm: [900, 250, 900, 250, 1200],
  mention: [80, 60, 80], start: [80, 60, 160], done: [60, 50, 60, 50, 220], test: [200, 100, 200],
  // engineering: three quick knocks and a long buzz (like a hammer), twice when urgent
  // an order was edited: a light triple tap
  edit: [60, 50, 60, 50, 60],
  // laundry: a load finished or was stopped, three long buzzes like a dryer
  laundry: [500, 200, 500, 200, 500],
  // a room is ready for inspection on the Board: two quick taps and a medium buzz
  insp: [120, 80, 120, 80, 400],
  eng: [90, 70, 90, 70, 90, 220, 650], engUrgent: [90, 70, 90, 70, 90, 220, 650, 300, 90, 70, 90, 70, 90, 220, 900] };

// Each hotel's alerts come with its own colored bell; alerts with no hotel use FrankShift purple.
const ICON = { MGT: 'notify-mgt.png', FDT: 'notify-fdt.png', HWY: 'notify-hwy.png' };
// The app keeps the server address and the person's session here, so "I'm on it" works from the alert itself.
async function auth(){
  try { const r = await (await caches.open('fs-pref')).match('fs-auth'); return r ? JSON.parse(await r.text()) : null; } catch { return null; }
}

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'FrankShift', body: e.data && e.data.text() }; }
  const urgent = !!d.urgent || /URGENT/.test(d.title || '');
  e.waitUntil(lang().then(l => {
    const es = l === 'es';
    const title = (es && d.title_es) || d.title || 'FrankShift';
    const body = (es && d.body_es) || d.body || (es ? 'Nuevo pedido' : 'New request');
    // Android shows these two buttons on alerts about an open order; iPhone shows none and a tap opens the order
    const actions = d.act === 'start' && d.oid ? [{ action: 'start', title: es ? 'Voy' : "I'm on it" }, { action: 'open', title: es ? 'Abrir' : 'Open' }] : [];
    return self.registration.showNotification(title, {
      body,
      actions,
      tag: d.tag || undefined,
      renotify: true,
      silent: false,
      requireInteraction: urgent,
      vibrate: VIBE[d.kind === 'eng' ? (urgent ? 'engUrgent' : 'eng') : d.kind === 'alarm' ? 'alarm' : urgent ? 'urgent' : d.kind] || [200, 100, 200],
      // the hotel bell: in colour inside the alert, and as a white silhouette in the Android status bar
      // (Android draws only the shape of a badge, so a full-colour square shows up as a white box)
      icon: ICON[d.hotel] || 'notify-fs.png',
      badge: 'badge-bell.png',
      timestamp: Date.now(),
      // maintenance alerts open Engineer
      data: { url: self.registration.scope + (d.kind === 'eng' ? '#eng' : d.hash === '#team' || d.hash === '#passon' || d.hash === '#laundry' || d.hash === '#board' ? d.hash : '#orders'),
        oid: d.oid || null, room: d.room || null, ticket: d.ticket || null, hotel: d.hotel || null, es },
    });
  }));
});

// "I'm on it" on the alert: take the order without opening the app, then tell whoever asked, like the button in the app does.
async function startFromAlert(d){
  const a = await auth();
  if (!a || !a.token || !a.api || !a.key) return false;
  const post = (path, body) => fetch(a.api + path, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: a.key }, body: JSON.stringify(body) });
  try {
    const r = await post('/rest/v1/rpc/sc_order_update', { p_token: a.token, p_order: d.oid, p_action: 'start', p_assignee: null });
    if (!r.ok) return false;
  } catch { return false; }
  post('/functions/v1/notify', { token: a.token, status_order: d.oid }).catch(() => {});
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  list.forEach(c => c.postMessage({ t: 'refresh' }));
  const where = d.room ? (d.es ? ' · Hab. ' : ' · Room ') + d.room : '';
  await self.registration.showNotification((d.es ? 'En proceso' : 'On it') + where, {
    body: (d.es ? 'Quedó a tu nombre. Márcala Lista en FrankShift al terminar.' : "It's yours now. Mark it Done in FrankShift when you finish.") + (d.ticket ? '\n' + d.ticket : ''),
    tag: d.ticket ? 'mine-' + d.ticket : 'mine', silent: true, renotify: false,
    icon: ICON[d.hotel] || 'notify-fs.png', badge: 'badge-bell.png', timestamp: Date.now(),
    data: { url: self.registration.scope + '#orders' } });
  return true;
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  if (e.action === 'start' && e.notification.data && e.notification.data.oid) {
    // if it can't be taken from here (taken already, signed out), open the order so the person sees why
    e.waitUntil(startFromAlert(e.notification.data).then(ok => ok ? null : openAt(url)));
    return;
  }
  e.waitUntil(openAt(url));
});
function openAt(url){
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    // the app is open: bring it up on the screen the alert is about
    for (const c of list) { if (c.url.startsWith(self.registration.scope)) { c.focus(); c.postMessage({ t: 'refresh', go: new URL(url).hash }); return; } }
    return self.clients.openWindow(url);
  });
}
