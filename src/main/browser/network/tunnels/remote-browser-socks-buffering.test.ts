import { EventEmitter } from 'node:events'
import { createServer, type Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteBrowserSocksServer } from './remote-browser-socks-server'

vi.mock('node:net', () => ({
  createServer: vi.fn(() => ({ listening: false }))
}))

function setup(requestTail: Buffer = Buffer.alloc(0)) {
  const upstream = new PassThrough()
  const write = vi.spyOn(upstream, 'write')
  const opened = Promise.withResolvers<PassThrough>()
  const open = vi.fn(() => opened.promise)
  const server = new RemoteBrowserSocksServer({ open })
  const socket = Object.assign(new EventEmitter(), {
    remoteAddress: '127.0.0.1',
    destroyed: false,
    write: vi.fn(() => true),
    pause: vi.fn(),
    end: vi.fn((_reply, callback) => callback()),
    pipe: vi.fn(),
    destroy: vi.fn(() => {
      socket.destroyed = true
      socket.emit('close')
    })
  })
  const accept = vi.mocked(createServer).mock.calls.at(-1)![0] as (socket: Socket) => void
  accept(socket as unknown as Socket)
  socket.emit('data', Buffer.from([5, 1, 0]))
  socket.emit('data', Buffer.concat([Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 1, 187]), requestTail]))
  return { server, socket, upstream, write, opened, open }
}

afterEach(() => vi.restoreAllMocks())

describe('pending browser SOCKS route buffering', () => {
  it('forwards every fragmented pending byte at the existing cap', async () => {
    const { server, socket, upstream, write, opened } = setup()
    const payload = Buffer.alloc(256 * 1024)
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = index % 251
    }
    try {
      for (let index = 0; index < payload.length; index += 256) {
        socket.emit('data', payload.subarray(index, index + 256))
      }
      opened.resolve(upstream)
      await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1))
      expect(Buffer.isBuffer(write.mock.calls[0][0])).toBe(true)
      expect(write.mock.calls[0][0]).toHaveLength(payload.length)
      expect(Buffer.prototype.equals.call(write.mock.calls[0][0], payload)).toBe(true)
    } finally {
      await server.close()
      upstream.destroy()
    }
  })

  it('keeps request-tail bytes ahead of later fragments in the pending payload', async () => {
    const tail = Buffer.from('GET / HTTP/1.1\r\n')
    const { server, socket, upstream, write, opened } = setup(tail)
    const rest = Buffer.from('Host: example.com\r\n\r\n')
    try {
      for (const byte of rest) {
        socket.emit('data', Buffer.from([byte]))
      }
      opened.resolve(upstream)
      await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1))
      expect(write.mock.calls[0][0]).toEqual(Buffer.concat([tail, rest]))
    } finally {
      await server.close()
      upstream.destroy()
    }
  })

  it('discards pending input on client close while the route is opening', async () => {
    const { server, socket, upstream, write, opened, open } = setup()
    try {
      await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1))
      socket.emit('data', Buffer.from('pending request'))
      socket.destroy()
      opened.resolve(upstream)
      await vi.waitFor(() => expect(upstream.destroyed).toBe(true))
      expect(write).not.toHaveBeenCalled()
    } finally {
      await server.close()
    }
  })
})
