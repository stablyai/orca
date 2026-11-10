// Orca's glue for noVNC, injected into vnc.html by orca-desktop-proxy. Orca (the desktop app's
// main process) drives it through window.orcaDesktop:
// - tickets: the page never connects by itself. Each WebSocket needs a fresh single-use ticket,
//   which Orca hands over with connect(ticket) after nextTicketRequest() resolves: 'ticket' on
//   load or after a session dropped, 'retry' after an attempt that never connected. Tickets live
//   only in memory here: never in the URL, storage or noVNC's settings.
// - pause(message, label): Orca stopped retrying; show why, with a Reconnect button. resume()
//   (Orca reopened the desktop) or the button asks for a ticket again.
// - fit: resize=remote makes Xvnc follow the tab; a server without SetDesktopSize gets scaling.
// - clipboard: a copy inside the desktop right after user input there goes to this computer's
//   clipboard; paste(text, chord) sets the sandbox's clipboard first, then replays the paste key.
import UI from './app/ui.js';
import * as WebUtil from './app/webutil.js';

const WS_PATH = 'websockify';
const RESIZE_FALLBACK_MS = 1500;
// A copy inside the desktop follows a copy key or a selection (drag or double-click) there; other
// clipboard changes (an agent in the sandbox running xclip) must not overwrite this computer's
// clipboard. Plain typing does not open the window.
const USER_COPY_WINDOW_MS = 1500;
const DRAG_PX = 4;
const MAX_CLIPBOARD_CHARS = 1 << 20;
const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;
const XK = { v: 0x0076, V: 0x0056, Insert: 0xff63, Shift_L: 0xffe1, Super_L: 0xffeb, Super_R: 0xffec };

let state = 'idle'; // idle | connecting | connected | disconnected | paused
let attemptConnected = true;
let ticketWaiters = [];
let lastCopyIntent = 0;
let pointerStart = null;

const style = document.createElement('style');
// Orca owns connecting and the chrome: noVNC's Connect button would only try without a ticket,
// and its control bar duplicates what the Orca tab does (fit, clipboard, keyboard release).
style.textContent = `
#noVNC_connect_dlg, #noVNC_control_bar_anchor { display: none !important; }
#orca_pause { position: fixed; inset: 0; display: none; align-items: center; justify-content: center;
  background: rgba(30, 31, 34, 0.92); z-index: 1000; font: 13px/1.5 system-ui, sans-serif; }
#orca_pause.open { display: flex; }
#orca_pause > div { max-width: 360px; padding: 16px; border: 1px solid #3a3b3f; border-radius: 8px;
  background: #26272b; color: #d4d4d4; text-align: center; }
#orca_pause button { margin-top: 12px; padding: 4px 12px; border: 1px solid #4a4b50; border-radius: 6px;
  background: transparent; color: #f2f2f2; font: inherit; cursor: pointer; }
#orca_pause button:focus-visible { outline: 2px solid #6ea8fe; outline-offset: 2px; }
/* The VM page cannot read Orca's --focus-ring token; this matches its dark value. */
`;
document.head.appendChild(style);

const overlay = document.createElement('div');
overlay.id = 'orca_pause';
overlay.innerHTML = '<div role="alert"><p></p><button type="button"></button></div>';
overlay.querySelector('button').addEventListener('click', () => resume());
document.addEventListener('DOMContentLoaded', () => document.body.appendChild(overlay));

window.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === 'c' || event.key === 'C' || event.key === 'Insert')) {
    lastCopyIntent = Date.now();
  }
}, true);
window.addEventListener('pointerdown', (event) => {
  pointerStart = { x: event.clientX, y: event.clientY };
}, true);
// A double- or triple-click selects a word or line (pointer events carry no click count).
window.addEventListener('mousedown', (event) => {
  if (event.detail >= 2) {
    lastCopyIntent = Date.now();
  }
}, true);
window.addEventListener('pointerup', (event) => {
  if (pointerStart && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) >= DRAG_PX) {
    lastCopyIntent = Date.now();
  }
  pointerStart = null;
}, true);

function requestTicket() {
  const answer = attemptConnected ? 'ticket' : 'retry';
  const waiters = ticketWaiters;
  ticketWaiters = [];
  waiters.forEach((resolve) => resolve(answer));
}

async function whenStarted() {
  while (document.documentElement.classList.contains('noVNC_loading')) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function onConnect() {
  state = 'connected';
  attemptConnected = true;
  UI.hideStatus();
  setTimeout(() => {
    // Xvnc answers SetDesktopSize; anything that does not gets scaled into the tab instead.
    if (UI.rfb && state === 'connected' && !UI.rfb._supportsSetDesktopSize) {
      UI.rfb.scaleViewport = true;
    }
  }, RESIZE_FALLBACK_MS);
}

function onDisconnect() {
  if (state === 'paused') {
    return;
  }
  state = 'disconnected';
  // The ticket is spent: ask Orca for a new one (a dropped forward, a restart of the desktop).
  requestTicket();
}

function onClipboard(event) {
  const text = event.detail && event.detail.text;
  if (typeof text !== 'string' || text.length > MAX_CLIPBOARD_CHARS) {
    return;
  }
  if (Date.now() - lastCopyIntent > USER_COPY_WINDOW_MS || !document.hasFocus()) {
    return;
  }
  navigator.clipboard.writeText(text).catch(() => {});
}

async function connect(ticket) {
  if (typeof ticket !== 'string' || !TICKET_RE.test(ticket)) {
    return 'invalid';
  }
  if (state === 'connecting' || state === 'connected' || state === 'paused') {
    return state;
  }
  await whenStarted();
  if (UI.rfb) {
    return 'connecting';
  }
  state = 'connecting';
  attemptConnected = false;
  // UI.connect reads the path setting synchronously and opens the WebSocket in RFB's constructor;
  // the in-memory setting is restored right after, so the ticket is never kept or shown.
  // Only ever this page's own origin: noVNC also reads host, port, encrypt, repeater and logging
  // from the URL, which must never send a ticketed session (and the user's keys) elsewhere.
  WebUtil.setSetting('host', '');
  WebUtil.setSetting('port', '');
  WebUtil.setSetting('encrypt', false);
  WebUtil.setSetting('repeaterID', '');
  WebUtil.setSetting('path', `${WS_PATH}?ticket=${ticket}`);
  try {
    UI.connect();
  } finally {
    WebUtil.setSetting('path', WS_PATH);
  }
  const rfb = UI.rfb;
  if (!rfb) {
    state = 'disconnected';
    requestTicket();
    return 'failed';
  }
  rfb.addEventListener('connect', onConnect);
  rfb.addEventListener('disconnect', onDisconnect);
  rfb.addEventListener('clipboard', onClipboard);
  return 'connecting';
}

/** Pastes this computer's clipboard: the sandbox's clipboard first, then the paste key itself. */
function paste(text, chord) {
  const rfb = UI.rfb;
  if (!rfb || state !== 'connected' || typeof text !== 'string' || text.length > MAX_CLIPBOARD_CHARS) {
    return false;
  }
  rfb.clipboardPasteFrom(text);
  if (chord && chord.kind === 'mac') {
    // Cmd+V: Linux apps do not paste on Super+V, so release Super and send Shift+Insert.
    rfb.sendKey(XK.Super_L, 'MetaLeft', false);
    rfb.sendKey(XK.Super_R, 'MetaRight', false);
    rfb.sendKey(XK.Shift_L, 'ShiftLeft', true);
    rfb.sendKey(XK.Insert, 'Insert');
    rfb.sendKey(XK.Shift_L, 'ShiftLeft', false);
  } else if (chord && chord.kind === 'replay') {
    // Ctrl+V, Ctrl+Shift+V, Shift+Insert: the held modifiers already reached the sandbox.
    const insert = chord.key === 'Insert';
    rfb.sendKey(insert ? XK.Insert : chord.key === 'V' ? XK.V : XK.v, insert ? 'Insert' : 'KeyV');
  }
  return true;
}

function pause(message, label, tone) {
  state = 'paused';
  if (UI.rfb) {
    UI.rfb.disconnect();
  }
  UI.hideStatus();
  overlay.querySelector('p').textContent = String(message || '');
  overlay.querySelector('button').textContent = String(label || 'Reconnect');
  // Asleep and starting are states, not errors: announce them politely.
  overlay.firstElementChild.setAttribute('role', tone === 'neutral' ? 'status' : 'alert');
  overlay.classList.add('open');
  overlay.querySelector('button').focus();
  return true;
}

function resume() {
  if (state !== 'paused') {
    return false;
  }
  overlay.classList.remove('open');
  state = 'disconnected';
  attemptConnected = true; // a person asked: start the retry budget over
  requestTicket();
  return true;
}

Object.defineProperty(window, 'orcaDesktop', {
  value: Object.freeze({
    version: 1,
    state: () => state,
    /** Resolves when the page needs a ticket: now if it is not connected, else after a drop. */
    nextTicketRequest: () => new Promise((resolve) => {
      ticketWaiters.push(resolve);
      if (state === 'idle' || state === 'disconnected') {
        requestTicket();
      }
    }),
    connect,
    paste,
    pause,
    resume
  })
});
