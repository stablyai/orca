import { EventEmitter, once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AvccFrame } from './avcc-frame-parser'
import { AvccFrameStream } from './avcc-frame-stream'

const streams: AvccFrameStream[] = []
let server: Server | null = null

function packet(tag: number, bytes: number[]): Buffer {
  const header = Buffer.alloc(5)
  header.writeUInt32BE(bytes.length + 1)
  header[4] = tag
  return Buffer.concat([header, Buffer.from(bytes)])
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
  return `http://127.0.0.1:${address.port}/stream.avcc?token=keep`
}

function subscribe(url: string): {
  stream: AvccFrameStream
  frames: AvccFrame[]
  errors: string[]
  events: EventEmitter
} {
  const frames: AvccFrame[] = []
  const errors: string[] = []
  const events = new EventEmitter()
  const stream = new AvccFrameStream(url, {
    onFrame: (frame) => {
      frames.push(frame)
      events.emit('frame')
    },
    onError: (message) => {
      errors.push(message)
      events.emit('stream-error')
    }
  })
  streams.push(stream)
  return { stream, frames, errors, events }
}

afterEach(async () => {
  for (const stream of streams.splice(0)) {
    stream.stop()
  }
  vi.useRealTimers()
  if (server) {
    const closed = once(server, 'close')
    server.closeAllConnections()
    server.close()
    await closed
    server = null
  }
})

describe('AvccFrameStream', () => {
  it('relays all complete packets through real HTTP and closes the live socket on stop', async () => {
    const lifecycle = new EventEmitter()
    let requestUrl = ''
    const url = await listen(
      createServer((request, response) => {
        requestUrl = request.url ?? ''
        response.once('close', () => lifecycle.emit('closed'))
        response.writeHead(200, { 'content-type': 'application/octet-stream' })
        response.write(Buffer.concat([packet(1, [1, 2]), packet(2, [3, 4]), packet(3, [5, 6])]))
      })
    )
    const { stream, frames, errors, events } = subscribe(url)
    stream.start()
    while (frames.length < 3) {
      await once(events, 'frame')
    }
    expect(frames).toEqual([
      { config: true, keyFrame: false, bytes: Uint8Array.from([1, 2]).buffer },
      { config: false, keyFrame: true, bytes: Uint8Array.from([3, 4]).buffer },
      { config: false, keyFrame: false, bytes: Uint8Array.from([5, 6]).buffer }
    ])
    expect(requestUrl).toBe('/stream.avcc?token=keep')
    const closed = once(lifecycle, 'closed')
    stream.stop()
    stream.stop()
    await closed
    expect(errors).toEqual([])
  })

  it('keeps a valid static stream alive past the handshake deadline', async () => {
    const lifecycle = new EventEmitter()
    const url = await listen(
      createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/octet-stream' })
        response.write(packet(4, [255, 216, 255, 217]))
        lifecycle.once('next', () => response.write(packet(2, [7, 8])))
      })
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { stream, frames, errors, events } = subscribe(url)
    const first = once(events, 'frame')
    stream.start()
    await first
    vi.advanceTimersByTime(60_000)
    expect(errors).toEqual([])
    const next = once(events, 'frame')
    lifecycle.emit('next')
    await next
    expect(frames).toEqual([
      {
        config: false,
        keyFrame: false,
        seed: true,
        bytes: Uint8Array.from([255, 216, 255, 217]).buffer
      },
      { config: false, keyFrame: true, bytes: Uint8Array.from([7, 8]).buffer }
    ])
    expect(errors).toEqual([])
  })

  it('times out a pending HTTP handshake and closes its request', async () => {
    const lifecycle = new EventEmitter()
    const url = await listen(
      createServer((_request, response) => {
        response.once('close', () => lifecycle.emit('closed'))
        lifecycle.emit('requested')
      })
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { stream, frames, errors, events } = subscribe(url)
    const requested = once(lifecycle, 'requested')
    stream.start()
    await requested
    const failed = once(events, 'stream-error')
    const closed = once(lifecycle, 'closed')
    vi.advanceTimersByTime(10_001)
    await failed
    await closed
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/timed out/i)
    expect(frames).toEqual([])
  })

  it.each(['HTTP error', 'EOF', 'malformed packet', 'socket error'] as const)(
    'reports %s once and releases the HTTP connection',
    async (failure) => {
      const lifecycle = new EventEmitter()
      const url = await listen(
        createServer((_request, response) => {
          response.once('close', () => lifecycle.emit('closed'))
          if (failure === 'socket error') {
            response.destroy()
          } else if (failure === 'HTTP error') {
            response.writeHead(503)
            response.end('Unavailable')
          } else {
            response.writeHead(200, { 'content-type': 'application/octet-stream' })
            if (failure === 'malformed packet') {
              response.write(packet(5, [1]))
            } else {
              response.end(packet(2, [1, 2]).subarray(0, 6))
            }
          }
        })
      )
      const { stream, frames, errors, events } = subscribe(url)
      const failed = once(events, 'stream-error')
      const closed = once(lifecycle, 'closed')
      stream.start()
      await failed
      await closed
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatch(
        failure === 'HTTP error' ? /503/ : failure === 'malformed packet' ? /tag/i : /ended|socket/i
      )
      expect(frames).toEqual([])
    }
  )

  it.each(['file:///tmp/stream.avcc', 'http://127.0.0.1/stream.mjpeg'])(
    'rejects an unsupported stream URL %s',
    (url) => {
      expect(() => subscribe(url)).toThrow(/http|stream\.avcc/i)
    }
  )
})
