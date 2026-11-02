import { EventEmitter, once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { encodeServeSimKeyboardFrame } from '../../shared/emulator-keyboard-frame'
import { encodeServeSimTouchFrame } from '../../shared/emulator-touch-frame'

const invokeHandlers = new Map<string, (event: unknown, args: unknown) => unknown>()
const eventHandlers = new Map<string, (event: unknown, args: unknown) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) => {
      invokeHandlers.set(channel, handler)
    },
    on: (channel: string, handler: (event: unknown, args: unknown) => unknown) => {
      eventHandlers.set(channel, handler)
    }
  },
  BrowserWindow: {
    fromWebContents: (sender: { isWindow: boolean }) => (sender.isWindow ? {} : null)
  }
}))

import { registerEmulatorControlStreamHandlers } from './emulator-control-stream'

class Owner extends EventEmitter {
  messages: { channel: string; data: unknown }[] = []
  isWindow = true
  destroyed = false
  failSend = false
  isDestroyed = (): boolean => this.destroyed
  send = (channel: string, data: unknown): void => {
    if (this.failSend) {
      throw new Error('Renderer is gone')
    }
    this.messages.push({ channel, data })
    this.emit(channel, data)
  }
}

type ControlServer = { wsUrl: string; wss: WebSocketServer; origins: (string | undefined)[] }
const owners: Owner[] = []
const servers: { server: Server; sockets: Set<Socket> }[] = []
const websocketServers: WebSocketServer[] = []

function owner(): Owner {
  const sender = new Owner()
  owners.push(sender)
  return sender
}

function start(sender: Owner, args: unknown): unknown {
  const handler = invokeHandlers.get('emulator:controlStreamStart')
  if (!handler) {
    throw new Error('Missing control start handler')
  }
  return handler({ sender }, args)
}

function send(sender: Owner, streamId: string, bytes: unknown): void {
  const handler = eventHandlers.get('emulator:controlFrame')
  if (!handler) {
    throw new Error('Missing control frame handler')
  }
  handler({ sender }, { streamId, bytes })
}

function stop(sender: Owner, streamId: string): void {
  const handler = eventHandlers.get('emulator:controlStreamStop')
  if (!handler) {
    throw new Error('Missing control stop handler')
  }
  handler({ sender }, { streamId })
}

async function listen(server: Server): Promise<string> {
  const sockets = new Set<Socket>()
  servers.push({ server, sockets })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
  })
  const listening = once(server, 'listening')
  server.listen(0, '127.0.0.1')
  await listening
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP server address')
  }
  return `ws://127.0.0.1:${address.port}`
}

async function controlServer(path = '/ws'): Promise<ControlServer> {
  const server = createServer()
  const wss = new WebSocketServer({
    server,
    path,
    verifyClient: ({ origin, req }, done) => {
      done(!origin || origin === `http://${req.headers.host}`, 403)
    }
  })
  websocketServers.push(wss)
  const origins: (string | undefined)[] = []
  wss.on('connection', (_socket, request) => origins.push(request.headers.origin))
  return { wsUrl: `${await listen(server)}${path}`, wss, origins }
}

function nextConnection(wss: WebSocketServer): Promise<WebSocket> {
  const { promise, resolve } = Promise.withResolvers<WebSocket>()
  wss.once('connection', (socket) => resolve(socket))
  return promise
}

async function open(sender: Owner, target: ControlServer, streamId: string): Promise<WebSocket> {
  const connection = nextConnection(target.wss)
  const connected = once(sender, 'emulator:controlStreamStatus')
  expect(start(sender, { streamId, wsUrl: target.wsUrl })).toBeUndefined()
  expect(await connected).toEqual([{ streamId, connected: true }])
  return connection
}

function serveSimConfigFrame(config: unknown): Buffer {
  return Buffer.concat([Buffer.from([130]), Buffer.from(JSON.stringify(config))])
}

function recordFrames(socket: WebSocket): { bytes: number[]; binary: boolean }[] {
  const frames: { bytes: number[]; binary: boolean }[] = []
  socket.on('message', (raw, binary) => {
    const bytes = Array.isArray(raw)
      ? Buffer.concat(raw)
      : Buffer.isBuffer(raw)
        ? raw
        : Buffer.from(raw)
    frames.push({ bytes: [...bytes], binary })
  })
  return frames
}

async function rejectedOrigin(wsUrl: string, origin: string): Promise<number> {
  const socket = new WebSocket(wsUrl, { origin })
  socket.on('error', () => {})
  const { promise, resolve, reject } = Promise.withResolvers<number>()
  socket.once('open', () => {
    socket.close()
    reject(new Error('Cross-origin handshake was accepted'))
  })
  socket.once('unexpected-response', (_request, response) => {
    response.destroy()
    socket.terminate()
    resolve(response.statusCode ?? 0)
  })
  return promise
}

function expectLifetimeReleased(sender: Owner): void {
  for (const event of ['did-navigate', 'render-process-gone', 'destroyed']) {
    expect(sender.listenerCount(event)).toBe(0)
  }
}

beforeEach(() => {
  invokeHandlers.clear()
  eventHandlers.clear()
  registerEmulatorControlStreamHandlers()
})

afterEach(async () => {
  for (const sender of owners.splice(0)) {
    sender.emit('destroyed')
  }
  for (const wss of websocketServers.splice(0)) {
    for (const client of wss.clients) {
      client.terminate()
    }
    const { promise, resolve } = Promise.withResolvers<void>()
    wss.close(() => resolve())
    await promise
  }
  for (const { server, sockets } of servers.splice(0)) {
    for (const socket of sockets) {
      socket.destroy()
    }
    const { promise, resolve } = Promise.withResolvers<void>()
    server.close(() => resolve())
    await promise
  }
})

it('delivers pushed orientations only to their owner without releasing held keys', async () => {
  const target = await controlServer()
  const sender = owner()
  const other = owner()
  const peer = await open(sender, target, 'orientation')
  await open(other, target, 'other')
  const frames = recordFrames(peer)
  const keyDown = encodeServeSimKeyboardFrame({ type: 'down', usage: 225 })
  const received = once(peer, 'message')
  send(sender, 'orientation', keyDown)
  await received

  for (const orientation of [
    'portrait',
    'landscape_left',
    'portrait_upside_down',
    'landscape_right'
  ]) {
    const status = once(sender, 'emulator:controlStreamStatus')
    peer.send(serveSimConfigFrame({ width: 1206, height: 2622, orientation }))
    expect(await status).toEqual([{ streamId: 'orientation', connected: true, orientation }])
  }
  expect(other.messages).toEqual([
    { channel: 'emulator:controlStreamStatus', data: { streamId: 'other', connected: true } }
  ])
  expect(frames).toEqual([{ bytes: [...keyDown], binary: true }])
  const disconnected = once(sender, 'emulator:controlStreamStatus')
  peer.close()
  expect(await disconnected).toEqual([
    { streamId: 'orientation', connected: false, pressedKeyboardUsages: [225] }
  ])
})

it('ignores malformed, oversized, text and unrelated configs before the next valid orientation', async () => {
  const target = await controlServer()
  const sender = owner()
  const peer = await open(sender, target, 'validated-config')
  const status = once(sender, 'emulator:controlStreamStatus')
  for (const frame of [
    Buffer.alloc(0),
    Buffer.from([130]),
    Buffer.from([130, 123]),
    Buffer.from([129, ...Buffer.from('{"orientation":"landscape_left"}')]),
    ...[
      null,
      [],
      'portrait',
      {},
      { orientation: 1 },
      { orientation: 'landscape' },
      { orientation: 'landscape_left', padding: 'x'.repeat(2048) }
    ].map(serveSimConfigFrame)
  ]) {
    peer.send(frame)
  }
  peer.send(JSON.stringify({ orientation: 'landscape_left' }))
  peer.send(serveSimConfigFrame({ orientation: 'portrait_upside_down' }))
  expect(await status).toEqual([
    { streamId: 'validated-config', connected: true, orientation: 'portrait_upside_down' }
  ])
  expect(sender.messages).toEqual([
    {
      channel: 'emulator:controlStreamStatus',
      data: { streamId: 'validated-config', connected: true }
    },
    {
      channel: 'emulator:controlStreamStatus',
      data: {
        streamId: 'validated-config',
        connected: true,
        orientation: 'portrait_upside_down'
      }
    }
  ])
})

it('does not deliver a queued orientation from a retired owner to a reused stream id', async () => {
  const target = await controlServer()
  const sender = owner()
  const other = owner()
  const retired = await open(sender, target, 'reused-orientation')
  const closed = once(retired, 'close')
  retired.send(serveSimConfigFrame({ orientation: 'landscape_left' }))
  stop(sender, 'reused-orientation')
  const current = await open(other, target, 'reused-orientation')
  await closed
  const status = once(other, 'emulator:controlStreamStatus')
  current.send(serveSimConfigFrame({ orientation: 'portrait' }))
  expect(await status).toEqual([
    { streamId: 'reused-orientation', connected: true, orientation: 'portrait' }
  ])
  expect(sender.messages).toEqual([
    {
      channel: 'emulator:controlStreamStatus',
      data: { streamId: 'reused-orientation', connected: true }
    }
  ])
  expect(other.messages).toEqual([
    {
      channel: 'emulator:controlStreamStatus',
      data: { streamId: 'reused-orientation', connected: true }
    },
    {
      channel: 'emulator:controlStreamStatus',
      data: { streamId: 'reused-orientation', connected: true, orientation: 'portrait' }
    }
  ])
})

it('closes the control socket instead of sending orientation to a destroyed owner', async () => {
  const target = await controlServer()
  const sender = owner()
  const peer = await open(sender, target, 'destroyed-orientation')
  const closed = once(peer, 'close')
  sender.destroyed = true
  peer.send(serveSimConfigFrame({ orientation: 'landscape_right' }))
  await closed
  expect(sender.messages).toEqual([
    {
      channel: 'emulator:controlStreamStatus',
      data: { streamId: 'destroyed-orientation', connected: true }
    }
  ])
  expectLifetimeReleased(sender)
})

it('uses a trusted main socket and delivers a held touch before its release', async () => {
  const target = await controlServer('/helper/test-device/ws')
  expect(await rejectedOrigin(target.wsUrl, 'http://localhost:15208')).toBe(403)
  expect(await rejectedOrigin(target.wsUrl, 'file://')).toBe(403)
  const sender = owner()
  const peer = await open(sender, target, 'live-touch')
  expect(target.origins).toEqual([undefined])
  const frames = recordFrames(peer)
  const begin = encodeServeSimTouchFrame({ type: 'begin', x: 0.5, y: 0.8 })
  const move = encodeServeSimTouchFrame({ type: 'move', x: 0.5, y: 0.5 })
  const end = encodeServeSimTouchFrame({ type: 'end', x: 0.5, y: 0.2 })
  for (const frame of [begin, move]) {
    const received = once(peer, 'message')
    send(sender, 'live-touch', frame)
    await received
  }
  expect(frames).toEqual([begin, move].map((bytes) => ({ bytes: [...bytes], binary: true })))
  const closed = once(peer, 'close')
  send(sender, 'live-touch', end)
  stop(sender, 'live-touch')
  expectLifetimeReleased(sender)
  await closed
  expect(frames).toEqual([begin, move, end].map((bytes) => ({ bytes: [...bytes], binary: true })))
})

it('flushes key releases in order before a graceful explicit stop', async () => {
  const target = await controlServer()
  const sender = owner()
  const peer = await open(sender, target, 'keyboard')
  const received = recordFrames(peer)
  const frames = [
    encodeServeSimKeyboardFrame({ type: 'down', usage: 225 }),
    encodeServeSimKeyboardFrame({ type: 'down', usage: 4 }),
    encodeServeSimKeyboardFrame({ type: 'up', usage: 4 }),
    encodeServeSimKeyboardFrame({ type: 'up', usage: 225 })
  ]
  const closed = once(peer, 'close')
  for (const frame of frames) {
    send(sender, 'keyboard', frame)
  }
  stop(sender, 'keyboard')
  expectLifetimeReleased(sender)
  const [code] = await closed
  expect(code).toBe(1005)
  expect(received).toEqual(frames.map((bytes) => ({ bytes: [...bytes], binary: true })))
})

it('isolates owners and accepts only bounded touch and keyboard binary frames', async () => {
  const target = await controlServer()
  const sender = owner()
  const other = owner()
  const peer = await open(sender, target, 'owned')
  const frames = recordFrames(peer)
  stop(other, 'owned')
  expect(() => start(other, { streamId: 'owned', wsUrl: target.wsUrl })).toThrow(/another renderer/)
  send(other, 'owned', Uint8Array.from([0x03, 9]))
  const oversized = new Uint8Array(1025)
  oversized[0] = 0x03
  for (const invalid of [
    undefined,
    [0x03, 1],
    new ArrayBuffer(2),
    new DataView(new ArrayBuffer(2)),
    new Uint8Array(),
    Uint8Array.from([0x03]),
    Uint8Array.from([0x01, 1]),
    Uint8Array.from([0x07, 1]),
    oversized
  ]) {
    expect(() => send(sender, 'owned', invalid)).not.toThrow()
  }
  const minimum = Uint8Array.from([0x03, 1])
  const maximum = new Uint8Array(1024)
  maximum[0] = 0x06
  for (const frame of [minimum, maximum]) {
    const received = once(peer, 'message')
    send(sender, 'owned', frame)
    await received
  }
  expect(frames).toEqual([minimum, maximum].map((bytes) => ({ bytes: [...bytes], binary: true })))
  expect(other.messages).toEqual([])
})

it('replaces a live socket without letting its stale close disconnect the replacement', async () => {
  const target = await controlServer()
  const sender = owner()
  const first = await open(sender, target, 'replace')
  const closed = once(first, 'close')
  const release = encodeServeSimKeyboardFrame({ type: 'up', usage: 4 })
  const oldFrames = recordFrames(first)
  send(sender, 'replace', release)
  const replacement = await open(sender, target, 'replace')
  await closed
  expect(oldFrames).toEqual([{ bytes: [...release], binary: true }])
  expect(sender.messages.map(({ data }) => data)).toEqual([
    { streamId: 'replace', connected: true },
    { streamId: 'replace', connected: true }
  ])
  const received = once(replacement, 'message')
  send(sender, 'replace', Uint8Array.from([0x03, 2]))
  expect(await received).toEqual([Buffer.from([0x03, 2]), true])
})

it.each(['explicit stop', 'did-navigate', 'render-process-gone', 'destroyed'])(
  'releases live ownership immediately after %s',
  async (goneEvent) => {
    const target = await controlServer()
    const sender = owner()
    const other = owner()
    const first = await open(sender, target, 'lifetime')
    const closed = once(first, 'close')
    if (goneEvent === 'explicit stop') {
      stop(sender, 'lifetime')
    } else {
      sender.emit(goneEvent)
    }
    expectLifetimeReleased(sender)
    const replacement = await open(other, target, 'lifetime')
    await closed
    stop(sender, 'lifetime')
    const received = once(replacement, 'message')
    send(other, 'lifetime', Uint8Array.from([0x03, 2]))
    expect(await received).toEqual([Buffer.from([0x03, 2]), true])
    expect(sender.messages.map(({ data }) => data)).toEqual([
      { streamId: 'lifetime', connected: true }
    ])
  }
)

it.each(['explicit stop', 'did-navigate', 'render-process-gone', 'destroyed', 'replacement'])(
  'cancels an unfinished handshake after %s without replaying pending input',
  async (goneEvent) => {
    const pendingServer = createServer()
    const pendingUpgrade = Promise.withResolvers<Duplex>()
    pendingServer.once('upgrade', (_request, socket) => {
      socket.resume()
      socket.once('end', () => socket.destroy())
      pendingUpgrade.resolve(socket)
    })
    const pendingUrl = `${await listen(pendingServer)}/ws`
    const target = await controlServer()
    const sender = owner()
    expect(start(sender, { streamId: 'pending', wsUrl: pendingUrl })).toBeUndefined()
    const pendingPeer = await pendingUpgrade.promise
    const closed = Promise.withResolvers<void>()
    pendingPeer.once('close', () => closed.resolve())
    send(sender, 'pending', Uint8Array.from([0x03, 9]))
    expect(sender.messages).toEqual([])
    if (goneEvent === 'explicit stop') {
      stop(sender, 'pending')
    } else if (goneEvent !== 'replacement') {
      sender.emit(goneEvent)
    }
    if (goneEvent !== 'replacement') {
      expectLifetimeReleased(sender)
    }
    const nextOwner = goneEvent === 'replacement' ? sender : owner()
    const peer = await open(nextOwner, target, 'pending')
    await closed.promise
    const frames = recordFrames(peer)
    const received = once(peer, 'message')
    send(nextOwner, 'pending', Uint8Array.from([0x06, 1]))
    await received
    expect(frames).toEqual([{ bytes: [0x06, 1], binary: true }])
    expect(sender.messages.map(({ data }) => data)).toEqual(
      goneEvent === 'replacement' ? [{ streamId: 'pending', connected: true }] : []
    )
  }
)

it('preserves held keys across a rejected reconnect and releases its request and renderer lifetime', async () => {
  const lifecycle = new EventEmitter()
  const server = createServer((_request, response) => {
    response.once('close', () => lifecycle.emit('closed'))
    response.writeHead(403)
    response.write('forbidden')
  })
  const wsUrl = `${await listen(server)}/ws`
  const sender = owner()
  const disconnected = once(sender, 'emulator:controlStreamStatus')
  const closed = once(lifecycle, 'closed')
  start(sender, { streamId: 'rejected', wsUrl, pressedKeyboardUsages: [225] })
  expect(await disconnected).toEqual([
    { streamId: 'rejected', connected: false, pressedKeyboardUsages: [225] }
  ])
  expectLifetimeReleased(sender)
  await closed
  const target = await controlServer()
  await open(owner(), target, 'rejected')
  expect(sender.messages).toHaveLength(1)
})

it('reports a peer close only to its owner and ignores later sends', async () => {
  const target = await controlServer()
  const sender = owner()
  const other = owner()
  const peer = await open(sender, target, 'peer-close')
  const disconnected = once(sender, 'emulator:controlStreamStatus')
  peer.close()
  expect(await disconnected).toEqual([{ streamId: 'peer-close', connected: false }])
  expectLifetimeReleased(sender)
  expect(() => send(sender, 'peer-close', Uint8Array.from([0x03, 1]))).not.toThrow()
  await open(other, target, 'peer-close')
  expect(sender.messages.map(({ data }) => data)).toEqual([
    { streamId: 'peer-close', connected: true },
    { streamId: 'peer-close', connected: false }
  ])
})

it('reports keys still held by the socket when a late release arrives after peer close', async () => {
  const target = await controlServer()
  const sender = owner()
  const peer = await open(sender, target, 'lost-key-up')
  const frames = recordFrames(peer)
  const accepted = [
    encodeServeSimKeyboardFrame({ type: 'down', usage: 225 }),
    encodeServeSimKeyboardFrame({ type: 'down', usage: 4 }),
    encodeServeSimKeyboardFrame({ type: 'up', usage: 4 })
  ]
  for (const frame of accepted) {
    const received = once(peer, 'message')
    send(sender, 'lost-key-up', frame)
    await received
  }
  const disconnected = once(sender, 'emulator:controlStreamStatus')
  peer.close()
  expect(await disconnected).toEqual([
    { streamId: 'lost-key-up', connected: false, pressedKeyboardUsages: [225] }
  ])
  send(sender, 'lost-key-up', encodeServeSimKeyboardFrame({ type: 'up', usage: 225 }))
  expect(frames).toEqual(accepted.map((bytes) => ({ bytes: [...bytes], binary: true })))
})

it('rejects invalid starts before replacing an existing trusted connection', async () => {
  const target = await controlServer()
  const sender = owner()
  const peer = await open(sender, target, 'validated')
  const invalidArgs: unknown[] = [
    undefined,
    null,
    {},
    { streamId: 1, wsUrl: target.wsUrl },
    { streamId: 'validated', wsUrl: 1 },
    ...[null, '225', [-1], [0x10000], Array(257).fill(225)].map((pressedKeyboardUsages) => ({
      streamId: 'validated',
      wsUrl: target.wsUrl,
      pressedKeyboardUsages
    })),
    ...[
      'not a URL',
      'http://remote.example/ws',
      'file:///ws',
      'ws://remote.example/exec',
      'ws://remote.example/exec/ws',
      'ws://remote.example/devtools/page/ws',
      'ws://remote.example/%65xec/ws',
      'ws://remote.example/helper/device/ws/exec',
      'ws://remote.example/helper/device/ws/',
      'ws://remote.example/ws#fragment'
    ].map((wsUrl) => ({ streamId: 'validated', wsUrl }))
  ]
  for (const args of invalidArgs) {
    expect(() => start(sender, args)).toThrow()
  }
  const guest = owner()
  guest.isWindow = false
  expect(() => start(guest, { streamId: 'guest', wsUrl: target.wsUrl })).toThrow(/BrowserWindow/)
  const received = once(peer, 'message')
  send(sender, 'validated', Uint8Array.from([0x03, 1]))
  expect(await received).toEqual([Buffer.from([0x03, 1]), true])
  expect(sender.messages).toHaveLength(1)
})

it('contains renderer status delivery failure and closes its socket', async () => {
  const target = await controlServer()
  const sender = owner()
  sender.failSend = true
  const connection = nextConnection(target.wss)
  start(sender, { streamId: 'gone-renderer', wsUrl: target.wsUrl })
  const peer = await connection
  await once(peer, 'close')
  expect(sender.messages).toEqual([])
  expectLifetimeReleased(sender)
})
