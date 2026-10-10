import { EventEmitter } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Socket } from 'node:net'
import { UnixSocketTransport } from './unix-socket-transport'
import type { UnixSocketStreamUpgrade } from './unix-socket-stream-upgrade'
import { UNIX_SOCKET_STREAM_MAX_BUFFERED_BYTES } from './unix-socket-stream-connection'
import {
  RUNTIME_LOCAL_STREAM_UPGRADE_METHOD,
  RuntimeLocalStreamFrameKind,
  encodeRuntimeLocalStreamFrame
} from '../../../shared/runtime-local-stream-protocol'

class FakeSocket extends EventEmitter {
  destroyed = false
  writable = true
  writableLength = 0
  ended = false
  idleTimeoutMs: number | null = null
  readonly writes: string[] = []
  readonly binaryWrites: Buffer[] = []

  setEncoding(): void {}
  setNoDelay(): void {}
  setTimeout(ms: number): void {
    this.idleTimeoutMs = ms
  }
  end(): void {
    this.ended = true
  }

  write(data: string | Buffer): boolean {
    if (typeof data === 'string') {
      this.writes.push(data)
    } else {
      this.binaryWrites.push(data)
    }
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

  it('retains only the byte count of the partial tail between messages', () => {
    const { socket, received } = createReceiver()
    const large = 'a'.repeat(700000)
    socket.emit('data', `${large}\npart`)
    socket.emit('data', `ial\r\n\n${large}\n`)
    expect(received).toEqual([large, 'partial', large])
  })

  it('checks the combined incoming buffer before dispatching any complete messages', () => {
    const { socket, received } = createReceiver()
    socket.emit('data', `${'a'.repeat(700000)}\n${'b'.repeat(700000)}\n`)
    expect(received).toEqual([''])
    socket.emit('data', 'later\n')
    expect(received).toEqual([''])
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

describe('UnixSocketTransport stream upgrade', () => {
  const upgradeLine = JSON.stringify({
    id: 'u1',
    authToken: 'token',
    method: RUNTIME_LOCAL_STREAM_UPGRADE_METHOD,
    params: { protocol: 'orca-local-stream', versions: [1] }
  })

  function createUpgradeReceiver() {
    const transport = new UnixSocketTransport({ endpoint: 'test-pipe', kind: 'named-pipe' })
    const socket = new FakeSocket()
    const messages: string[] = []
    const upgrades: { raw: string; upgrade: UnixSocketStreamUpgrade }[] = []
    transport.onMessage((message, reply) => {
      messages.push(message)
      reply('unary')
    })
    transport.onStreamUpgrade((raw, upgrade) => upgrades.push({ raw, upgrade }))
    ;(transport as unknown as UnixSocketTransportInternals).handleConnection(
      socket as unknown as Socket
    )
    return { socket, messages, upgrades }
  }

  it('hands the first upgrade line to the upgrade handler and frames pipelined bytes after accept', () => {
    const { socket, messages, upgrades } = createUpgradeReceiver()
    const early = encodeRuntimeLocalStreamFrame(RuntimeLocalStreamFrameKind.Text, '{"id":"r1"}')
    socket.emit('data', Buffer.concat([Buffer.from(`${upgradeLine}\n`), early.subarray(0, 3)]))
    socket.emit('data', early.subarray(3))
    expect(messages).toEqual([])
    expect(upgrades.map((entry) => entry.raw)).toEqual([upgradeLine])

    const texts: string[] = []
    const connection = upgrades[0]!.upgrade.accept('{"id":"u1","ok":true}')
    connection?.bind({ onText: (text) => texts.push(text), onBinary: () => {}, onClose: () => {} })
    expect(socket.writes).toEqual(['{"id":"u1","ok":true}\n'])
    expect(socket.idleTimeoutMs).toBe(0)
    expect(texts).toEqual(['{"id":"r1"}'])

    socket.emit('data', encodeRuntimeLocalStreamFrame(RuntimeLocalStreamFrameKind.Text, 'next\n'))
    expect(texts).toEqual(['{"id":"r1"}', 'next\n'])
    expect(messages).toEqual([])

    expect(connection?.sendBinary(new Uint8Array([1, 2]))).toBe(true)
    expect([...socket.binaryWrites[0]!]).toEqual([
      RuntimeLocalStreamFrameKind.Binary,
      0,
      0,
      0,
      2,
      1,
      2
    ])
  })

  it('writes the refusal and ends the socket when the runtime rejects the upgrade', () => {
    const { socket, upgrades } = createUpgradeReceiver()
    socket.emit('data', `${upgradeLine}\n`)
    upgrades[0]!.upgrade.reject('{"id":"u1","ok":false}')
    expect(socket.writes).toEqual(['{"id":"u1","ok":false}\n'])
    expect(socket.ended).toBe(true)
    expect(upgrades[0]!.upgrade.accept('{"id":"u1","ok":true}')).toBeNull()
  })

  it('keeps an upgrade line after another request on the unary path', () => {
    const { socket, messages, upgrades } = createUpgradeReceiver()
    socket.emit('data', `{"id":"a","method":"status.get"}\n${upgradeLine}\n`)
    expect(upgrades).toEqual([])
    expect(messages).toEqual(['{"id":"a","method":"status.get"}', upgradeLine])
  })

  it('closes a stream whose frame exceeds the inbound cap', () => {
    const { socket, upgrades } = createUpgradeReceiver()
    socket.emit('data', `${upgradeLine}\n`)
    const connection = upgrades[0]!.upgrade.accept('{"id":"u1","ok":true}')
    const onClose = vi.fn()
    connection?.bind({ onText: () => {}, onBinary: () => {}, onClose })
    const header = Buffer.alloc(5)
    header[0] = RuntimeLocalStreamFrameKind.Binary
    header.writeUInt32BE(2 * 1024 * 1024, 1)
    socket.emit('data', header)
    expect(socket.destroyed).toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('reports a discard instead of queueing binary frames past the buffered ceiling', () => {
    const { socket, upgrades } = createUpgradeReceiver()
    socket.emit('data', `${upgradeLine}\n`)
    const connection = upgrades[0]!.upgrade.accept('{"id":"u1","ok":true}')
    socket.writableLength = UNIX_SOCKET_STREAM_MAX_BUFFERED_BYTES
    expect(connection?.sendBinary(new Uint8Array([1]))).toBe(false)
    expect(socket.destroyed).toBe(false)
  })
})
