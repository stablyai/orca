import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Socket } from 'node:net'
import { UnixSocketTransport } from './unix-socket-transport'

class FakeSocket extends EventEmitter {
  destroyed = false
  writable = true
  readonly writes: string[] = []

  setEncoding(): void {}
  setNoDelay(): void {}
  setTimeout(): void {}

  write(data: string): boolean {
    this.writes.push(data)
    return true
  }

  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true
      this.writable = false
      this.emit('close')
    }
    return this
  }
}

type UnixSocketTransportInternals = {
  handleConnection(socket: Socket): void
}

describe('UnixSocketTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('clears request keepalive timers when the socket closes before a reply', () => {
    const transport = new UnixSocketTransport({
      endpoint: '/tmp/orca-runtime-rpc-test.sock',
      kind: 'unix',
      keepaliveIntervalMs: 100
    })
    const socket = new FakeSocket()
    let aborted = false

    transport.onMessage((_msg, _reply, context) => {
      context?.signal?.addEventListener(
        'abort',
        () => {
          aborted = true
        },
        { once: true }
      )
      context?.startKeepalive()
    })

    ;(transport as unknown as UnixSocketTransportInternals).handleConnection(
      socket as unknown as Socket
    )
    socket.emit('data', Buffer.from('{"id":"pending","method":"wait"}\n'))

    vi.advanceTimersByTime(100)
    expect(socket.writes).toHaveLength(1)

    socket.destroy()
    expect(aborted).toBe(true)

    vi.advanceTimersByTime(500)
    expect(socket.writes).toHaveLength(1)
  })

  it('parses a request delivered as 100,000 one-byte fragments', () => {
    const transport = new UnixSocketTransport({
      endpoint: '/tmp/orca-runtime-rpc-test.sock',
      kind: 'unix'
    })
    const socket = new FakeSocket()
    let received = ''
    transport.onMessage((message) => {
      received = message
    })
    ;(transport as unknown as UnixSocketTransportInternals).handleConnection(
      socket as unknown as Socket
    )

    const request = Buffer.from(`${' '.repeat(99_960)}{"id":"tiny","method":"status"}\n`)
    for (let index = 0; index < request.byteLength; index += 1) {
      socket.emit('data', request.subarray(index, index + 1))
    }

    expect(received).toBe('{"id":"tiny","method":"status"}')
  })
})
