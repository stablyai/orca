import { EventEmitter, once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { EmulatorVideoStreamStartArgs } from '../../shared/emulator-video-stream'

const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  },
  BrowserWindow: { fromWebContents: () => ({}) }
}))
vi.mock('../emulator/emulator-probe', () => ({ emulatorProbe: () => {} }))

import { scrcpyVideoRegistry } from '../emulator/scrcpy-video-registry'
import { registerEmulatorVideoStreamHandlers } from './emulator-video-stream'

class Owner extends EventEmitter {
  messages: { channel: string; data: unknown }[] = []
  isDestroyed = (): boolean => false
  send = (channel: string, data: unknown): void => {
    this.messages.push({ channel, data })
    this.emit(channel, data)
  }
}

const owners: Owner[] = []
const devices = new Set<string>()
let server: Server | null = null

function owner(): Owner {
  const sender = new Owner()
  owners.push(sender)
  return sender
}

function start(sender: Owner, args: EmulatorVideoStreamStartArgs): unknown {
  const handler = handlers.get('emulator:videoStreamStart')
  if (!handler) {
    throw new Error('Missing video start handler')
  }
  return handler({ sender }, args)
}

function stop(sender: Owner, streamId: string): void {
  handlers.get('emulator:videoStreamStop')?.({ sender }, { streamId })
}

function packet(tag: number): Buffer {
  return Buffer.from([0, 0, 0, 3, tag, 11, 22])
}

async function listen(httpServer: Server): Promise<string> {
  server = httpServer
  const listening = once(httpServer, 'listening')
  httpServer.listen(0, '127.0.0.1')
  await listening
  const address = httpServer.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP server address')
  }
  return `http://127.0.0.1:${address.port}/stream.avcc`
}

beforeEach(() => {
  handlers.clear()
  registerEmulatorVideoStreamHandlers()
})

afterEach(async () => {
  for (const sender of owners.splice(0)) {
    sender.emit('destroyed')
  }
  for (const device of devices) {
    scrcpyVideoRegistry.stop(device)
  }
  devices.clear()
  vi.useRealTimers()
  if (server) {
    const closed = once(server, 'close')
    server.closeAllConnections()
    server.close()
    await closed
    server = null
  }
})

it('preserves ownership when stopping or replacing a live AVCC subscription', async () => {
  const lifecycle = new EventEmitter()
  const avccStreamUrl = await listen(
    createServer((_request, response) => {
      response.once('close', () => lifecycle.emit('closed'))
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.write(packet(2))
      lifecycle.once('next', () => response.write(packet(3)))
    })
  )
  const sender = owner()
  const other = owner()
  const args = { streamId: 'owned', deviceId: 'simulator', avccStreamUrl }
  const first = once(sender, 'emulator:videoStreamFrame')
  expect(start(sender, args)).toEqual({ streamId: 'owned' })
  await first
  stop(other, args.streamId)
  expect(() => start(other, args)).toThrow(/another renderer/)
  const next = once(sender, 'emulator:videoStreamFrame')
  lifecycle.emit('next')
  await next
  expect(sender.messages.map(({ data }) => data)).toEqual([
    {
      streamId: 'owned',
      deviceId: 'simulator',
      config: false,
      keyFrame: true,
      bytes: Uint8Array.from([11, 22]).buffer
    },
    {
      streamId: 'owned',
      deviceId: 'simulator',
      config: false,
      keyFrame: false,
      bytes: Uint8Array.from([11, 22]).buffer
    }
  ])
  expect(other.messages).toEqual([])
  const closed = once(lifecycle, 'closed')
  stop(sender, args.streamId)
  await closed
  expect(sender.listenerCount('destroyed')).toBe(0)
})

it.each(['did-navigate', 'render-process-gone', 'destroyed'])(
  'closes the main-owned AVCC socket when its renderer emits %s',
  async (goneEvent) => {
    const lifecycle = new EventEmitter()
    const avccStreamUrl = await listen(
      createServer((_request, response) => {
        response.once('close', () => lifecycle.emit('closed'))
        response.writeHead(200, { 'content-type': 'application/octet-stream' })
        response.write(packet(2))
      })
    )
    const sender = owner()
    const received = once(sender, 'emulator:videoStreamFrame')
    start(sender, { streamId: 'lifetime', deviceId: 'simulator', avccStreamUrl })
    await received
    const closed = once(lifecycle, 'closed')
    sender.emit(goneEvent)
    await closed
    expect(sender.messages).toHaveLength(1)
    expect(sender.listenerCount('destroyed')).toBe(0)
  }
)

it.each(['did-navigate', 'render-process-gone', 'destroyed', 'explicit stop'])(
  'cancels pending AVCC construction after %s',
  (goneEvent) => {
    vi.useFakeTimers()
    const sender = owner()
    start(sender, {
      streamId: 'pending',
      deviceId: 'simulator',
      avccStreamUrl: 'file:///invalid/stream.avcc'
    })
    if (goneEvent === 'explicit stop') {
      stop(sender, 'pending')
    } else {
      sender.emit(goneEvent)
    }
    vi.runOnlyPendingTimers()
    expect(sender.messages).toEqual([])
    expect(sender.listenerCount('destroyed')).toBe(0)
  }
)

it('contains a deferred constructor error and releases its renderer lifetime', () => {
  vi.useFakeTimers()
  const sender = owner()
  expect(
    start(sender, {
      streamId: 'bad-url',
      deviceId: 'simulator',
      avccStreamUrl: 'file:///invalid/stream.avcc'
    })
  ).toEqual({ streamId: 'bad-url' })
  expect(() => vi.runOnlyPendingTimers()).not.toThrow()
  expect(sender.messages).toEqual([
    {
      channel: 'emulator:videoStreamError',
      data: { streamId: 'bad-url', deviceId: 'simulator', message: expect.stringMatching(/http/i) }
    }
  ])
  expect(sender.listenerCount('destroyed')).toBe(0)
})

it('reports malformed HTTP packets only to their owner and leaves Android delivery intact', async () => {
  const lifecycle = new EventEmitter()
  const avccStreamUrl = await listen(
    createServer((_request, response) => {
      response.once('close', () => lifecycle.emit('closed'))
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.write(packet(5))
    })
  )
  const sender = owner()
  const android = owner()
  const deviceId = 'emulator-5554'
  devices.add(deviceId)
  scrcpyVideoRegistry.register(deviceId, () => {})
  const meta = { codecId: 'h264', width: 1080, height: 2400 }
  scrcpyVideoRegistry.pushMeta(deviceId, meta)
  const androidReady = once(android, 'emulator:videoStreamMeta')
  const failed = once(sender, 'emulator:videoStreamError')
  const closed = once(lifecycle, 'closed')
  start(sender, { streamId: 'malformed', deviceId: 'simulator', avccStreamUrl })
  start(android, { streamId: 'android', deviceId })
  await androidReady
  await failed
  await closed
  expect(sender.messages).toEqual([
    {
      channel: 'emulator:videoStreamError',
      data: { streamId: 'malformed', deviceId: 'simulator', message: expect.stringMatching(/tag/i) }
    }
  ])
  expect(sender.listenerCount('destroyed')).toBe(0)
  const frame = {
    config: true,
    keyFrame: false,
    pts: '0',
    bytes: Uint8Array.from([0, 0, 0, 1]).buffer
  }
  scrcpyVideoRegistry.pushFrame(deviceId, frame)
  expect(android.messages).toEqual([
    { channel: 'emulator:videoStreamMeta', data: { streamId: 'android', deviceId, meta } },
    { channel: 'emulator:videoStreamFrame', data: { streamId: 'android', deviceId, ...frame } }
  ])
  stop(android, 'android')
  scrcpyVideoRegistry.pushFrame(deviceId, frame)
  expect(android.messages).toHaveLength(2)
  expect(android.listenerCount('destroyed')).toBe(0)
})
