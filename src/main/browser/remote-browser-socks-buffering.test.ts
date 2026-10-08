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
  it('copies fragmented pending bytes linearly and forwards every byte at the existing cap', async () => {
    const { server, socket, upstream, write, opened } = setup()
    const payload = Buffer.alloc(256 * 1024)
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = index % 251
    }
    let copiedBytes = 0
    const originalCopy = Buffer.prototype.copy
    const copy = vi.spyOn(Buffer.prototype, 'copy').mockImplementation(function (target, ...args) {
      const copied = originalCopy.call(this, target, ...args)
      copiedBytes += copied
      return copied
    })
    const concat = vi.spyOn(Buffer, 'concat')
    try {
      for (let index = 0; index < payload.length; index += 256) {
        socket.emit('data', payload.subarray(index, index + 256))
      }
      expect(concat.mock.calls.length).toBe(0)
      expect(copiedBytes).toBeLessThan(payload.length * 3)
      opened.resolve(upstream)
      await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1))
      expect(write.mock.calls[0][0]).toEqual(payload)
    } finally {
      copy.mockRestore()
      concat.mockRestore()
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

  it('rejects one byte beyond the cap and destroys a late upstream without forwarding', async () => {
    const { server, socket, upstream, write, opened, open } = setup()
    try {
      await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1))
      socket.emit('data', Buffer.alloc(256 * 1024))
      expect(socket.destroyed).toBe(false)
      socket.emit('data', Buffer.from([1]))
      expect(socket.destroyed).toBe(true)
      expect(socket.end.mock.calls[0][0][1]).toBe(1)
      opened.resolve(upstream)
      await vi.waitFor(() => expect(upstream.destroyed).toBe(true))
      expect(write).not.toHaveBeenCalled()
    } finally {
      await server.close()
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
