import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Socket } from 'node:net'
import { UnixSocketTransport } from './unix-socket-transport'

class FakeSocket extends EventEmitter {
  destroyed = false
  writable = true
  writableLength = 0
  writeReturn = true
  ended = false
  readonly writes: string[] = []

  setEncoding(): void {}
  setNoDelay(): void {}
  setTimeout(): void {}

  write(data: string): boolean {
    this.writes.push(data)
    if (!this.writeReturn) {
      this.writableLength += Buffer.byteLength(data)
    }
    return this.writeReturn
  }

  end(): this {
    this.ended = true
    this.writable = false
    return this
  }

  destroy(_error?: Error): this {
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

  it('writes multiple frames only after a request starts streaming', () => {
    const transport = new UnixSocketTransport({
      endpoint: '/tmp/orca-runtime-rpc-test.sock',
      kind: 'unix'
    })
    const socket = new FakeSocket()

    transport.onMessage((_msg, reply, context) => {
      context?.startStreaming()
      reply('{"result":{"type":"scrollback"}}')
      reply('{"result":{"type":"data","chunk":"live"}}')
      context?.finishStreaming()
    })

    ;(transport as unknown as UnixSocketTransportInternals).handleConnection(
      socket as unknown as Socket
    )
    socket.emit('data', '{"id":"stream","method":"terminal.subscribe"}\n')

    expect(socket.writes).toEqual([
      '{"result":{"type":"scrollback"}}\n',
      '{"result":{"type":"data","chunk":"live"}}\n'
    ])
    expect(socket.ended).toBe(true)
    expect(socket.destroyed).toBe(false)
  })

  it('keeps ordinary replies one-shot', () => {
    const transport = new UnixSocketTransport({
      endpoint: '/tmp/orca-runtime-rpc-test.sock',
      kind: 'unix'
    })
    const socket = new FakeSocket()

    transport.onMessage((_msg, reply) => {
      reply('{"ok":true}')
      reply('{"ok":false}')
    })

    ;(transport as unknown as UnixSocketTransportInternals).handleConnection(
      socket as unknown as Socket
    )
    socket.emit('data', '{"id":"one-shot","method":"status.get"}\n')

    expect(socket.writes).toEqual(['{"ok":true}\n'])
    expect(socket.ended).toBe(false)
    expect(socket.destroyed).toBe(false)
  })

  it('aborts a stream before socket write buffering can grow past its limit', () => {
    const transport = new UnixSocketTransport({
      endpoint: '/tmp/orca-runtime-rpc-test.sock',
      kind: 'unix',
      maxPendingWriteBytes: 80
    })
    const socket = new FakeSocket()
    socket.writeReturn = false
    let aborted = false

    transport.onMessage((_msg, reply, context) => {
      context?.signal.addEventListener('abort', () => {
        aborted = true
      })
      context?.startStreaming()
      reply(JSON.stringify({ result: { type: 'data', chunk: 'a'.repeat(30) } }))
      reply(JSON.stringify({ result: { type: 'data', chunk: 'b'.repeat(30) } }))
    })

    ;(transport as unknown as UnixSocketTransportInternals).handleConnection(
      socket as unknown as Socket
    )
    socket.emit('data', '{"id":"stream","method":"terminal.subscribe"}\n')

    expect(socket.writes).toHaveLength(1)
    expect(socket.destroyed).toBe(true)
    expect(aborted).toBe(true)
    expect(socket.writableLength).toBeLessThanOrEqual(80)
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
