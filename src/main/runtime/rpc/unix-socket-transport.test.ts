import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Socket } from 'node:net'
import { UnixSocketTransport } from './unix-socket-transport'

class FakeSocket extends EventEmitter {
  destroyed = false
  writable = true
  readonly writes: string[] = []
  private idleTimeoutMs = 0
  private idleTimer: NodeJS.Timeout | null = null
  private onIdleTimeout: (() => void) | null = null

  setEncoding(): void {}
  setNoDelay(): void {}

  // Why: mirrors real net.Socket — any write (e.g. a keepalive frame) resets
  // the idle timer, matching the behavior the fix under test depends on.
  setTimeout(ms: number, callback: () => void): void {
    this.idleTimeoutMs = ms
    this.onIdleTimeout = callback
    this.resetIdleTimer()
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    if (this.idleTimeoutMs > 0 && this.onIdleTimeout) {
      this.idleTimer = setTimeout(() => this.onIdleTimeout?.(), this.idleTimeoutMs)
    }
  }

  write(data: string): boolean {
    this.writes.push(data)
    this.resetIdleTimer()
    return true
  }

  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true
      this.writable = false
      if (this.idleTimer) {
        clearTimeout(this.idleTimer)
        this.idleTimer = null
      }
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

  it('keeps the socket alive past a shortened idle window when keepalives are armed', () => {
    const idleTimeoutMs = 100
    const transport = new UnixSocketTransport({
      endpoint: '/tmp/orca-runtime-rpc-test.sock',
      kind: 'unix',
      keepaliveIntervalMs: 40,
      idleTimeoutMs
    })
    const socket = new FakeSocket()
    let reply: ((response: string) => void) | undefined

    transport.onMessage((_msg, replyFn, context) => {
      reply = replyFn
      context?.startKeepalive()
    })

    ;(transport as unknown as UnixSocketTransportInternals).handleConnection(
      socket as unknown as Socket
    )
    socket.emit('data', '{"id":"slow","method":"accounts.list"}\n')

    // Advance well past the idle window; keepalive writes must keep resetting it.
    vi.advanceTimersByTime(idleTimeoutMs * 3)
    expect(socket.destroyed).toBe(false)

    reply?.('{"id":"slow","ok":true}')
    expect(socket.writes.at(-1)).toBe('{"id":"slow","ok":true}\n')
  })

  it('destroys the socket after a shortened idle window when keepalives are not armed', () => {
    const idleTimeoutMs = 100
    const transport = new UnixSocketTransport({
      endpoint: '/tmp/orca-runtime-rpc-test.sock',
      kind: 'unix',
      keepaliveIntervalMs: 40,
      idleTimeoutMs
    })
    const socket = new FakeSocket()
    let reply: ((response: string) => void) | undefined

    // Why: deliberately never calls context.startKeepalive() — nothing resets the idle timer.
    transport.onMessage((_msg, replyFn) => {
      reply = replyFn
    })

    ;(transport as unknown as UnixSocketTransportInternals).handleConnection(
      socket as unknown as Socket
    )
    socket.emit('data', '{"id":"slow","method":"accounts.list"}\n')

    vi.advanceTimersByTime(idleTimeoutMs * 3)
    expect(socket.destroyed).toBe(true)

    // A reply arriving after destruction must not be written.
    reply?.('{"id":"slow","ok":true}')
    expect(socket.writes).toHaveLength(0)
  })
})
