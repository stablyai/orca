import { EventEmitter, once } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import type * as WsModule from 'ws'
import { EmulatorBridge } from '../emulator/emulator-bridge'
import { registerEmulatorControlStreamHandlers } from './emulator-control-stream'

const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    removeAllListeners: () => {},
    removeHandler: () => {},
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) =>
      handlers.set(channel, handler),
    on: (channel: string, handler: (event: unknown, args: unknown) => unknown) =>
      handlers.set(channel, handler)
  },
  BrowserWindow: { fromWebContents: () => ({}) }
}))
vi.mock('ws', async (importOriginal) => {
  const actual = await importOriginal<typeof WsModule>()
  return {
    ...actual,
    default: Object.assign(
      vi.fn(function (url: string) {
        return new actual.default(url)
      }),
      { OPEN: actual.default.OPEN }
    )
  }
})

class Owner extends EventEmitter {
  isDestroyed = (): boolean => false
  send = (_channel: string, event: { type: string; data?: unknown }): void => {
    this.emit(event.type, event.data)
  }
}

const owners: Owner[] = []
let server: WebSocketServer | undefined

afterEach(async () => {
  for (const owner of owners.splice(0)) {
    owner.emit('destroyed')
  }
  if (server) {
    for (const socket of server.clients) {
      socket.terminate()
    }
    const closed = once(server, 'close')
    server.close()
    await closed
    server = undefined
  }
  vi.clearAllMocks()
})

function setup(wsUrl: string) {
  const bridge = new EmulatorBridge()
  bridge.registerActiveEmulator('worktree', {
    deviceUdid: 'device',
    streamUrl: 'http://127.0.0.1/stream.mjpeg',
    wsUrl
  })
  registerEmulatorControlStreamHandlers(() => bridge)
  const sender = new Owner()
  owners.push(sender)
  return {
    sender,
    start: (url = wsUrl, streamId = 'control') =>
      handlers.get('emulator:controlStreamStart')?.({ sender }, { wsUrl: url, streamId })
  }
}

it('never connects to URLs outside the registered session', () => {
  const { start } = setup('ws://127.0.0.1:3100/ws')
  for (const url of [
    'ws://127.0.0.1:3101/ws',
    'ws://example.com/ws',
    'ws://127.0.0.1:3100/other'
  ]) {
    expect(() => start(url)).toThrow('registered emulator session')
  }
  expect(WebSocket).not.toHaveBeenCalled()
})

it('relays text and binary without Origin and releases the socket when the renderer goes away', async () => {
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP address')
  }
  const { sender, start } = setup(`ws://127.0.0.1:${address.port}/ws`)
  const connection = once(server, 'connection')
  const opened = once(sender, 'open')
  start()
  const [socket, request] = await connection
  const otherRenderer = new Owner()
  handlers.get('emulator:controlStreamSend')?.(
    { sender: otherRenderer },
    { streamId: 'control', data: 'unowned' }
  )
  handlers.get('emulator:controlStreamStop')?.({ sender: otherRenderer }, { streamId: 'control' })
  await opened
  expect(request.headers.origin).toBeUndefined()
  for (const data of ['text', new Uint8Array([130, 1, 2])]) {
    const received = once(socket, 'message')
    handlers.get('emulator:controlStreamSend')?.({ sender }, { streamId: 'control', data })
    const [bytes, binary] = await received
    expect(binary).toBe(typeof data !== 'string')
    expect(bytes.toString()).toBe(Buffer.from(data).toString())
    const relayed = once(sender, 'message')
    socket.send(data)
    const [frame] = await relayed
    expect(frame instanceof ArrayBuffer ? new Uint8Array(frame) : frame).toEqual(data)
  }
  const closed = once(socket, 'close')
  sender.emit('destroyed')
  await closed
})
