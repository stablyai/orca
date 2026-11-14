import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import type { Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import type { RawData } from 'ws'
import { RELAY_ADMISSION_BUDGETS } from '@orca-cloud/relay-contract/admission-budgets'
import { ProcessQueuedByteBudget, wireSplice } from './splice-forwarder.js'

// SAFETY: ws exports Receiver at runtime; its published types omit this Writable constructor.
const { Receiver } = createRequire(new URL('../splice-forwarder.test.ts', import.meta.url))('ws') as {
  Receiver: new (options: { isServer: true }) => Writable
}

class FakeSocket extends EventEmitter {
  readonly OPEN = 1
  readyState = 1
  bufferedAmount = 0
  sent: Array<{ data: unknown; binary: boolean }> = []
  closes: Array<{ code: number; reason: string }> = []
  _socket = { pause: vi.fn(), resume: vi.fn(), setNoDelay: vi.fn() }

  send(data: unknown, options: { binary: boolean }): void {
    this.sent.push({ data, binary: options.binary })
  }

  close(code: number, reason: string): void {
    this.readyState = 3
    this.closes.push({ code, reason })
    this.emit('close', code, Buffer.from(reason))
  }
}

describe('splice forwarder', () => {
  afterEach(() => vi.useRealTimers())

  it('hard-closes a splice exceeding the queue limit and releases its global queued-byte reservation', () => {
    const client = new FakeSocket()
    const host = new FakeSocket()
    host.bufferedAmount = 1024 * 1024
    const budget = new ProcessQueuedByteBudget()
    wireSplice({
      client: client as unknown as WebSocket,
      host: host as unknown as WebSocket,
      budget,
      onClose: vi.fn()
    })
    client.emit('message', Buffer.alloc(8 * 1024 * 1024), true)
    client.emit('message', Buffer.alloc(512 * 1024), true)
    expect(client.closes[0]?.code).toBe(4429)
    expect(host.closes[0]?.code).toBe(4429)
    expect(budget.current()).toBe(0)
  })

  it('queues one full catalog-sized frame for a backpressured peer without closing', () => {
    // Large workspace catalogs exceed 1MiB; one maxFrameBytes frame must survive backpressure.
    vi.useFakeTimers()
    const client = new FakeSocket()
    const host = new FakeSocket()
    host.bufferedAmount = 1024 * 1024
    const budget = new ProcessQueuedByteBudget()
    const onClose = vi.fn()
    wireSplice({
      client: client as unknown as WebSocket,
      host: host as unknown as WebSocket,
      budget,
      onClose
    })
    const frame = Buffer.alloc(8 * 1024 * 1024)
    client.emit('message', frame, true)
    expect(client.closes).toEqual([])
    expect(host.closes).toEqual([])

    host.bufferedAmount = 0
    vi.advanceTimersByTime(25)
    expect(host.sent).toHaveLength(1)
    expect(host.sent[0]?.data).toBe(frame)
    expect(host.sent[0]?.binary).toBe(true)
    expect(budget.current()).toBe(0)
    expect(onClose).not.toHaveBeenCalled()
    client.close(1000, 'done')
  })

  it('bounds empty messages already decoded from one paused-socket read', () => {
    const client = new FakeSocket()
    const host = new FakeSocket()
    host.bufferedAmount = 1024 * 1024
    const budget = new ProcessQueuedByteBudget()
    const closed = vi.fn()
    wireSplice({
      client: client as unknown as WebSocket,
      host: host as unknown as WebSocket,
      budget,
      onClose: vi.fn(),
      onClosed: closed
    })
    const receiver = new Receiver({ isServer: true })
    receiver.on('message', (data: RawData, binary: boolean) => client.emit('message', data, binary))
    // Masked, empty binary frames: 6 bytes each on the wire.
    const batch = Buffer.alloc((RELAY_ADMISSION_BUDGETS.spliceHardQueuedFrames + 1) * 6)
    for (let offset = 0; offset < batch.length; offset += 6) {
      batch[offset] = 0x82
      batch[offset + 1] = 0x80
    }

    receiver.write(batch)

    expect(closed).toHaveBeenCalledWith({
      code: 4429,
      reason: 'relay queue limit exceeded',
      trigger: 'queue-frame-limit'
    })
    expect(host.sent).toEqual([])
    expect(client.closes[0]?.code).toBe(4429)
    expect(host.closes[0]?.code).toBe(4429)
    expect(budget.current()).toBe(0)
  })
})
