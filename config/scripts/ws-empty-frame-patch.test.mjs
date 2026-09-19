import { Writable } from 'node:stream'
import { Sender } from 'ws'
import { describe, expect, it, vi } from 'vitest'

class EmptyBufferRejectingSocket extends Writable {
  chunks = []

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk))
    callback()
  }

  _writev(chunks, callback) {
    if (chunks.some(({ chunk }) => chunk.length === 0 && chunk.buffer.byteLength === 0)) {
      callback(Object.assign(new Error('writev EFAULT'), { code: 'EFAULT' }))
      return
    }
    this.chunks.push(...chunks.map(({ chunk }) => Buffer.from(chunk)))
    callback()
  }
}

describe('patched ws empty frame transmission', () => {
  it.each([false, true])('preserves empty control/data frames with mask=%s', async (mask) => {
    for (const opcode of [1, 2, 8, 9, 10]) {
      const socket = new EmptyBufferRejectingSocket()
      const onError = vi.fn()
      socket.on('error', onError)
      const sender = new Sender(socket)
      const frame = Sender.frame(Buffer.alloc(0), {
        fin: true,
        opcode,
        mask,
        generateMask: (buffer) => buffer.fill(0x12)
      })
      const expected = Buffer.concat(frame)
      const callback = vi.fn()
      await new Promise((resolve) => {
        sender.sendFrame(frame, (error) => {
          callback(error ?? undefined)
          resolve()
        })
      })
      expect(callback).toHaveBeenCalledExactlyOnceWith(undefined)
      expect(onError).not.toHaveBeenCalled()
      expect(Buffer.concat(socket.chunks)).toEqual(expected)
      socket.destroy()
    }
  })

  it('preserves nonempty payload bytes and the write callback', async () => {
    const socket = new EmptyBufferRejectingSocket()
    const sender = new Sender(socket)
    const frame = Sender.frame(Buffer.from('heartbeat'), { fin: true, opcode: 9, mask: false })
    await new Promise((resolve, reject) => {
      sender.sendFrame(frame, (error) => (error ? reject(error) : resolve()))
    })
    expect(Buffer.concat(socket.chunks)).toEqual(Buffer.concat(frame))
    expect(socket.chunks).toHaveLength(2)
    socket.destroy()
  })

  it('forwards socket failures when writing an empty frame header', async () => {
    const failure = new Error('socket write failed')
    const socket = new Writable({ write: (_chunk, _encoding, callback) => callback(failure) })
    socket.on('error', () => {})
    const sender = new Sender(socket)
    const frame = Sender.frame(Buffer.alloc(0), { fin: true, opcode: 10, mask: false })
    const error = await new Promise((resolve) => sender.sendFrame(frame, resolve))
    expect(error).toBe(failure)
    socket.destroy()
  })
})
