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
    socket.emit('data', '{"id":"pending","method":"wait"}\n')

    vi.advanceTimersByTime(100)
    expect(socket.writes).toHaveLength(1)

    socket.destroy()
    expect(aborted).toBe(true)

    vi.advanceTimersByTime(500)
    expect(socket.writes).toHaveLength(1)
  })

  it('stops and destroys a bounded keepalive connection at expiry', () => {
    const transport = new UnixSocketTransport({
      endpoint: '/tmp/orca-runtime-rpc-test.sock',
      kind: 'unix',
      keepaliveIntervalMs: 100
    })
    const socket = new FakeSocket()

    transport.onMessage((_msg, _reply, context) => {
      context?.startKeepalive(250)
    })

    ;(transport as unknown as UnixSocketTransportInternals).handleConnection(
      socket as unknown as Socket
    )
    socket.emit('data', '{"id":"bounded","method":"worktree.create"}\n')

    vi.advanceTimersByTime(300)
    expect(socket.writes).toHaveLength(2)
    expect(socket.destroyed).toBe(true)

    vi.advanceTimersByTime(300)
    expect(socket.writes).toHaveLength(2)
  })

  it('returns a bounded failure without destroying sibling dispatches', () => {
    const transport = new UnixSocketTransport({
      endpoint: '/tmp/orca-runtime-rpc-test.sock',
      kind: 'unix',
      keepaliveIntervalMs: 100
    })
    const socket = new FakeSocket()
    let dispatchCount = 0
    let siblingReply: ((response: string) => void) | undefined

    transport.onMessage((_msg, reply, context) => {
      dispatchCount += 1
      if (dispatchCount === 1) {
        context?.startKeepalive(250)
      } else {
        siblingReply = reply
      }
    })

    ;(transport as unknown as UnixSocketTransportInternals).handleConnection(
      socket as unknown as Socket
    )
    socket.emit(
      'data',
      '{"id":"slow","method":"worktree.create"}\n{"id":"sibling","method":"status.get"}\n'
    )

    vi.advanceTimersByTime(300)
    expect(socket.destroyed).toBe(false)
    expect(dispatchCount).toBe(2)
    expect(socket.writes.at(-1)).toContain('"id":"slow"')
    expect(socket.writes.at(-1)).toContain('"requestPhase":"awaiting_response"')
    expect(siblingReply).toBeTypeOf('function')
    siblingReply?.('{"id":"sibling","ok":true}')
    expect(socket.writes.at(-1)).toContain('"id":"sibling"')
  })
})
