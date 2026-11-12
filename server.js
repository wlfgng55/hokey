const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const W = 400, H = 700, PR = 34, BR = 20, GW = 150, WIN = 7;
const PORT = process.env.PORT || 3000;
const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});
const wss = new WebSocketServer({ server });
const rooms = new Map();

function newRoom(code) {
  return {
    code, players: [null, null], names: ['', ''],
    pad: [{ x: W / 2, y: H - 110, tx: W / 2, ty: H - 110, vx: 0, vy: 0 },
          { x: W / 2, y: 110, tx: W / 2, ty: 110, vx: 0, vy: 0 }],
    puck: { x: W / 2, y: H / 2, vx: 0, vy: 0 },
    sc: [0, 0], st: 'wait', pauseUntil: 0, serveDir: 1
  };
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function coll(r, p) {
  const u = r.puck, dx = u.x - p.x, dy = u.y - p.y, d = Math.hypot(dx, dy), m = PR + BR;
  if (d < m && d > 0.001) {
    const nx = dx / d, ny = dy / d;
    u.x = p.x + nx * m; u.y = p.y + ny * m;
    const dot = (u.vx - p.vx) * nx + (u.vy - p.vy) * ny;
    if (dot < 0) { u.vx -= 1.9 * dot * nx; u.vy -= 1.9 * dot * ny; }
    const s = Math.hypot(u.vx, u.vy);
    if (s > 1300) { u.vx *= 1300 / s; u.vy *= 1300 / s; }
  }
}
function goal(r, who) {
  r.sc[who]++;
  const u = r.puck; u.x = W / 2; u.y = H / 2; u.vx = 0; u.vy = 0;
  if (r.sc[who] >= WIN) r.st = 'over';
  else { r.st = 'pause'; r.pauseUntil = Date.now() + 1300; }
  r.serveDir = who === 0 ? -1 : 1;
}
function movePad(p, dt) {
  const k = Math.min(1, dt * 28), ox = p.x, oy = p.y;
  p.x += (p.tx - p.x) * k; p.y += (p.ty - p.y) * k;
  p.vx = clamp((p.x - ox) / dt, -1800, 1800); p.vy = clamp((p.y - oy) / dt, -1800, 1800);
}
function step(r, dt) {
  r.pad.forEach(p => movePad(p, dt));
  const both = r.players[0] && r.players[1];
  const u = r.puck, now = Date.now();
  if (!both) { r.st = 'wait'; r.sc = [0, 0]; u.x = W / 2; u.y = H / 2; u.vx = u.vy = 0; return; }
  if (r.st === 'wait') { r.sc = [0, 0]; r.st = 'pause'; r.pauseUntil = now + 1500; r.serveDir = Math.random() < .5 ? 1 : -1; }
  if (r.st === 'pause' && now >= r.pauseUntil) { r.st = 'play'; u.vy = r.serveDir * 240; u.vx = (Math.random() - .5) * 100; }
  if (r.st !== 'play') return;
  u.x += u.vx * dt; u.y += u.vy * dt;
  const f = Math.max(0, 1 - .12 * dt); u.vx *= f; u.vy *= f;
  if (u.x < BR) { u.x = BR; u.vx = Math.abs(u.vx) * .95; }
  if (u.x > W - BR) { u.x = W - BR; u.vx = -Math.abs(u.vx) * .95; }
  const inGap = Math.abs(u.x - W / 2) < GW / 2 - BR * .3;
  if (u.y < BR && !inGap) { u.y = BR; u.vy = Math.abs(u.vy) * .95; }
  if (u.y > H - BR && !inGap) { u.y = H - BR; u.vy = -Math.abs(u.vy) * .95; }
  coll(r, r.pad[0]); coll(r, r.pad[1]);
  if (u.y < -BR) goal(r, 0); else if (u.y > H + BR) goal(r, 1);
}
function snapshot(r) {
  const u = r.puck, a = r.pad[0], b = r.pad[1];
  return JSON.stringify({
    t: 's', bx: +u.x.toFixed(1), by: +u.y.toFixed(1), vx: +u.vx.toFixed(1), vy: +u.vy.toFixed(1),
    p0: [+a.x.toFixed(1), +a.y.toFixed(1)], p1: [+b.x.toFixed(1), +b.y.toFixed(1)],
    sc: r.sc, st: r.st, names: r.names
  });
}

let last = Date.now(), tick = 0;
setInterval(() => {
  const now = Date.now(), dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000)); last = now; tick++;
  for (const r of rooms.values()) {
    step(r, dt);
    if (tick % 2 === 0) {
      const msg = snapshot(r);
      r.players.forEach(ws => { if (ws && ws.readyState === 1) ws.send(msg); });
    }
  }
}, 16);

wss.on('connection', ws => {
  let room = null, idx = -1;
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === 'join' && !room) {
      const code = String(m.code || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
      if (!code) return;
      let r = rooms.get(code);
      if (!r) { r = newRoom(code); rooms.set(code, r); }
      const i = r.players[0] ? (r.players[1] ? -1 : 1) : 0;
      if (i < 0) { ws.send(JSON.stringify({ t: 'err', msg: 'Oda dolu.' })); return; }
      room = r; idx = i; r.players[i] = ws;
      r.names[i] = String(m.name || 'Oyuncu').slice(0, 14);
      ws.send(JSON.stringify({ t: 'hello', role: i, code }));
    } else if (m.t === 'move' && room) {
      const p = room.pad[idx];
      p.tx = clamp(+m.x || 0, PR, W - PR);
      p.ty = idx === 0 ? clamp(+m.y || 0, H / 2 + PR, H - PR) : clamp(+m.y || 0, PR, H / 2 - PR);
    } else if (m.t === 'again' && room && room.st === 'over') {
      room.sc = [0, 0]; room.st = 'pause'; room.pauseUntil = Date.now() + 1300;
      room.serveDir = Math.random() < .5 ? 1 : -1;
    }
  });
  ws.on('close', () => {
    if (!room) return;
    room.players[idx] = null; room.names[idx] = '';
    if (!room.players[0] && !room.players[1]) rooms.delete(room.code);
  });
});

server.listen(PORT, () => console.log('Hokey sunucusu calisiyor: ' + PORT));
