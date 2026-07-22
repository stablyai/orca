/**
 * S1 two-client ink convergence against live node-a collab-canvas-sync.
 * Two TLSyncClient heads share one board room; desktop puts a marker shape;
 * tablet must observe it in its store.
 */
import { createTLSchema } from '@tldraw/tlschema'
import { Store } from '@tldraw/store'
import { TLSyncClient } from '@tldraw/sync-core'
import { atom } from '@tldraw/state'
import { createRequire } from 'node:module'

// Node polyfills required by tldraw store/sync

globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.devicePixelRatio = 1
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis
}
globalThis.window.devicePixelRatio = 1


const require = createRequire('/home/nixos/meshina/sidecars/collab-canvas-sync/package.json')
const WebSocket = require('ws')

const BOARD = process.env.BOARD_ID || `ink-gate-${Date.now().toString(36)}`
const ORIGIN = process.env.COLLAB_ORIGIN || 'ws://node-a:5858'
const MARKER = 'DESKTOP_INK_MARKER_GATE'

function makeSocket(uri) {
  let ws = null
  const msgListeners = new Set()
  const statusListeners = new Set()
  const socket = {
    connectionStatus: 'offline',
    sendMessage(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
    },
    onReceiveMessage(cb) {
      msgListeners.add(cb)
      return () => msgListeners.delete(cb)
    },
    onStatusChange(cb) {
      statusListeners.add(cb)
      return () => statusListeners.delete(cb)
    },
    restart() {
      this.close()
      this._connect()
    },
    close() {
      try { ws?.close() } catch {}
      ws = null
      this.connectionStatus = 'offline'
      for (const cb of statusListeners) cb({ status: 'offline' })
    },
    _connect() {
      ws = new WebSocket(uri)
      ws.on('open', () => {
        this.connectionStatus = 'online'
        for (const cb of statusListeners) cb({ status: 'online' })
      })
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString())
          for (const cb of msgListeners) cb(msg)
        } catch {}
      })
      ws.on('close', () => {
        this.connectionStatus = 'offline'
        for (const cb of statusListeners) cb({ status: 'offline' })
      })
      ws.on('error', (err) => {
        this.connectionStatus = 'error'
        for (const cb of statusListeners) cb({ status: 'error', reason: String(err) })
      })
    }
  }
  socket._connect()
  return socket
}

function makeClient(name) {
  const schema = createTLSchema()
  const store = new Store({ schema, props: {} })
  const socket = makeSocket(`${ORIGIN}/connect/${BOARD}`)
  const presence = atom('presence', null)
  const presenceMode = atom('presenceMode', 'full')
  let afterConnect = false
  const client = new TLSyncClient({
    store,
    socket,
    presence,
    presenceMode,
    onLoad: () => {},
    onSyncError: (r) => console.error(name, 'syncError', r),
    onAfterConnect: () => {
      afterConnect = true
    }
  })
  return { name, store, socket, client, afterConnect: () => afterConnect }
}

function hasMarker(store) {
  return store.allRecords().some((r) => JSON.stringify(r).includes(MARKER))
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

const desktop = makeClient('desktop')
const tablet = makeClient('tablet')

// Wait until both sockets online and afterConnect fired (room hydrated)
const start = Date.now()
while (Date.now() - start < 10000) {
  if (
    desktop.socket.connectionStatus === 'online' &&
    tablet.socket.connectionStatus === 'online' &&
    desktop.afterConnect() &&
    tablet.afterConnect()
  ) {
    break
  }
  await wait(100)
}

if (!desktop.afterConnect() || !tablet.afterConnect()) {
  console.error(JSON.stringify({ ok: false, error: 'clients did not connect', board: BOARD }))
  process.exit(2)
}

const page = desktop.store.allRecords().find((r) => r.typeName === 'page')
const pageId = page?.id ?? 'page:page'

// Put geo shape with marker text on desktop
const shape = {
  id: 'shape:ink-gate-1',
  typeName: 'shape',
  type: 'geo',
  x: 42,
  y: 84,
  rotation: 0,
  index: 'a1',
  parentId: pageId,
  isLocked: false,
  opacity: 1,
  props: {
    geo: 'rectangle',
    w: 200,
    h: 100,
    color: 'red',
    fill: 'none',
    dash: 'draw',
    size: 'm',
    font: 'draw',
    align: 'middle',
    verticalAlign: 'middle',
    growY: 0,
    scale: 1,
    url: '',
    labelColor: 'black',
    richText: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: MARKER }] }]
    }
  },
  meta: { meshGate: MARKER }
}

try {
  desktop.store.put([shape])
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: 'put failed: ' + e.message }))
  process.exit(3)
}

// Poll tablet for marker
let seen = false
for (let i = 0; i < 50; i++) {
  if (hasMarker(tablet.store)) {
    seen = true
    break
  }
  await wait(100)
}

const result = {
  ok: seen,
  board: BOARD,
  origin: ORIGIN,
  cloudflare: false,
  desktopRecords: desktop.store.allRecords().length,
  tabletRecords: tablet.store.allRecords().length,
  desktopHasMarker: hasMarker(desktop.store),
  tabletHasMarker: seen,
  note: seen
    ? 'tablet store contains desktop-put shape marker — cross-visible ink'
    : 'tablet never received desktop marker'
}
console.log(JSON.stringify(result, null, 2))

desktop.client.close()
desktop.socket.close()
tablet.client.close()
tablet.socket.close()
process.exit(seen ? 0 : 4)
