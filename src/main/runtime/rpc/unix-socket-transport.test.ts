import { EventEmitter } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Socket } from 'node:net'
import { UnixSocketTransport } from './unix-socket-transport'

class FakeSocket extends EventEmitter {
  destroyed = false
  writable = true
  readonly writes: string[] = []
  private idleMs = 0
  private idleHandler: (() => void) | null = null
  private idleTimer: NodeJS.Timeout | null = null

  setEncoding(): void {}
  setNoDelay(): void {}
  end(): void {}

  // Match setTimeout: positive arms, zero suspends, and callback-free rearm preserves the handler.
  setTimeout(ms: number, handler?: () => void): this {
    if (handler) {
      this.idleHandler = handler
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    this.idleMs = ms
    if (ms > 0 && this.idleHandler) {
      this.idleTimer = setTimeout(() => this.idleHandler?.(), ms)
    }
    return this
  }

  write(data: string): boolean {
    this.writes.push(data)
    this.refreshIdleTimer()
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

  emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'data') {
      this.refreshIdleTimer()
    }
    return super.emit(event, ...args)
  }

  // Traffic resets the idle window; net.Socket counts reads and writes alike.
  private refreshIdleTimer(): void {
    this.setTimeout(this.idleMs)
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

  function createReceiver() {
    const transport = new UnixSocketTransport({ endpoint: 'test-pipe', kind: 'named-pipe' })
    const socket = new FakeSocket()
    const received: string[] = []
    transport.onMessage((message, reply) => {
      received.push(message)
      reply('ok')
    })
    ;(transport as unknown as UnixSocketTransportInternals).handleConnection(
      socket as unknown as Socket
    )
    return { socket, received }
  }

  it.each([false, true])('preserves the UTF-8 byte boundary with oversized=%s', (oversized) => {
    const { socket, received } = createReceiver()
    const message = `${'é'.repeat(524287)}a${oversized ? 'x' : ''}`
    const wire = Buffer.from(`${message}\n`)
    const decoder = new StringDecoder('utf8')
    for (let offset = 0; offset < wire.length; offset += 4095) {
      socket.emit('data', decoder.write(wire.subarray(offset, offset + 4095)))
    }
    expect(received).toEqual([oversized ? '' : message])
  })

  it('writes progress as keepalive frames only until the reply is sent', () => {
    const transport = new UnixSocketTransport({
      endpoint: '/tmp/orca-runtime-rpc-test.sock',
      kind: 'unix'
    })
    const socket = new FakeSocket()
    transport.onMessage((_msg, reply, context) => {
      context?.reportProgress?.({ phase: 'running-create' })
      reply('{"id":"req","ok":true}')
      context?.reportProgress?.({ phase: 'too-late' })
    })
    ;(transport as unknown as UnixSocketTransportInternals).handleConnection(
      socket as unknown as Socket
    )
    socket.emit('data', '{"id":"req","method":"worktree.create"}\n')
    expect(socket.writes).toEqual([
      '{"_keepalive":true,"progress":{"phase":"running-create"}}\n',
      '{"id":"req","ok":true}\n'
    ])
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
})
