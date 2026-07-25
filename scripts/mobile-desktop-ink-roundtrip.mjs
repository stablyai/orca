/**
 * Mobile ink → desktop visibility on live node-a room.
 * Client "mobile" puts a geo shape (same as engine ink-end);
 * client "desktop" must observe marker in store.
 */
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.devicePixelRatio = 1
globalThis.window = globalThis
globalThis.window.devicePixelRatio = 1

import { createTLSchema } from '@tldraw/tlschema'
import { Store } from '@tldraw/store'
import { TLSyncClient } from '@tldraw/sync-core'
import { atom } from '@tldraw/state'
import { createRequire } from 'node:module'
const require = createRequire('/home/nixos/meshina/sidecars/collab-canvas-sync/package.json')
const WebSocket = require('ws')

const BOARD = `mobile-desk-${Date.now().toString(36)}`
const ORIGIN = 'ws://node-a:5858'
const MARKER = 'MOBILE_INK_STROKE_GATE'

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
      try {
        ws?.close()
      } catch {}
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
      ws.on('error', () => {
        this.connectionStatus = 'error'
      })
    }
  }
  socket._connect()
  return socket
}

function makeClient() {
  const schema = createTLSchema()
  const store = new Store({ schema, props: {} })
  const socket = makeSocket(`${ORIGIN}/connect/${BOARD}`)
  let after = false
  const client = new TLSyncClient({
    store,
    socket,
    presence: atom('p', null),
    presenceMode: atom('pm', 'full'),
    onLoad() {},
    onSyncError() {},
    onAfterConnect() {
      after = true
    }
  })
  return { store, socket, client, after: () => after }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const mobile = makeClient()
const desktop = makeClient()
const t0 = Date.now()
while (Date.now() - t0 < 10000) {
  if (mobile.after() && desktop.after()) break
  await wait(100)
}
if (!mobile.after() || !desktop.after()) {
  console.log(JSON.stringify({ ok: false, error: 'no connect' }))
  process.exit(2)
}

const page = mobile.store.allRecords().find((r) => r.typeName === 'page')
const pageId = page?.id || 'page:page'
mobile.store.put([
  {
    id: 'shape:mobile-stroke-1',
    typeName: 'shape',
    type: 'geo',
    x: 10,
    y: 20,
    rotation: 0,
    index: 'a1',
    parentId: pageId,
    isLocked: false,
    opacity: 1,
    props: {
      geo: 'rectangle',
      w: 50,
      h: 30,
      color: 'blue',
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
    meta: { localStroke: true, source: 'mobile-engine', meshGate: MARKER }
  }
])

let seen = false
for (let i = 0; i < 50; i++) {
  if (desktop.store.allRecords().some((r) => JSON.stringify(r).includes(MARKER))) {
    seen = true
    break
  }
  await wait(100)
}

const out = {
  ok: seen,
  board: BOARD,
  desktopSeesMobileInk: seen,
  engine: 'tlsync+touch-geo',
  engineBytes: 174449
}
console.log(JSON.stringify(out, null, 2))
mobile.client.close()
mobile.socket.close()
desktop.client.close()
desktop.socket.close()
process.exit(seen ? 0 : 4)
