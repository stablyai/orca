import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import type { Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import type { RawData } from 'ws'
import { RELAY_ADMISSION_BUDGETS } from '@orca-cloud/relay-contract'
import {
  ProcessQueuedByteBudget,
  wireSplice,
  type SpliceCloseInfo
} from './splice-forwarder.js'

// SAFETY: ws exports Receiver at runtime; its published types omit this Writable constructor.
const { Receiver } = createRequire(import.meta.url)('ws') as {
  Receiver: new (options: { isServer: true }) => Writable
}

const FRAME_OVERHEAD = RELAY_ADMISSION_BUDGETS.queuedFrameOverheadBytes

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
  it('preserves text/binary opcodes and propagates peer close', () => {
    const client = new FakeSocket()
    const host = new FakeSocket()
    const onClose = vi.fn()
    const onForwardedBytes = vi.fn()
    wireSplice({
      client: client as unknown as WebSocket,
      host: host as unknown as WebSocket,
      budget: new ProcessQueuedByteBudget(),
      onClose,
      onForwardedBytes
    })
    client.emit('message', Buffer.from('text'), false)
    client.emit('message', Buffer.from([1, 2]), true)
    expect(host.sent).toEqual([
      { data: Buffer.from('text'), binary: false },
      { data: Buffer.from([1, 2]), binary: true }
    ])
    expect(onForwardedBytes.mock.calls).toEqual([[4], [2]])
    client.emit('close', 1000, Buffer.alloc(0))
    expect(host.closes[0]?.code).toBe(4408)
    expect(onClose).toHaveBeenCalledOnce()
  })

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
    expect(budget.current()).toBe(8 * 1024 * 1024 + FRAME_OVERHEAD)
    client.emit('message', Buffer.alloc(512 * 1024), true)
    expect(client.closes[0]?.code).toBe(4429)
    expect(host.closes[0]?.code).toBe(4429)
    expect(budget.current()).toBe(0)
  })

  it('reports the close trigger so limit and oversize kills are attributable', () => {
    const wire = (): { client: FakeSocket; host: FakeSocket; closes: SpliceCloseInfo[] } => {
      const client = new FakeSocket()
      const host = new FakeSocket()
      const closes: SpliceCloseInfo[] = []
      wireSplice({
        client: client as unknown as WebSocket,
        host: host as unknown as WebSocket,
        budget: new ProcessQueuedByteBudget(),
        onClose: vi.fn(),
        onClosed: (closeInfo) => closes.push(closeInfo)
      })
      return { client, host, closes }
    }

    const queueLimit = wire()
    queueLimit.host.bufferedAmount = 1024 * 1024
    queueLimit.client.emit('message', Buffer.alloc(8 * 1024 * 1024), true)
    queueLimit.client.emit('message', Buffer.alloc(512 * 1024), true)
    expect(queueLimit.closes).toEqual([
      { code: 4429, reason: 'relay queue limit exceeded', trigger: 'queue-limit' }
    ])

    // The ws receiver error for a frame above maxPayload names the payload cap.
    const oversize = wire()
    oversize.host.emit('error', new RangeError('Max payload size exceeded'))
    expect(oversize.closes[0]?.trigger).toBe('host-oversize-frame')

    const peerClose = wire()
    peerClose.client.emit('close', 1001, Buffer.alloc(0))
    expect(peerClose.closes[0]?.trigger).toBe('client-closed')
    expect(peerClose.closes).toHaveLength(1)
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
    expect(budget.current()).toBe(8 * 1024 * 1024 + FRAME_OVERHEAD)

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

    expect(client._socket.pause).toHaveBeenCalledTimes(
      RELAY_ADMISSION_BUDGETS.spliceHardQueuedFrames
    )
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

  it('charges empty queued frames against the shared byte budget until drained or closed', () => {
    vi.useFakeTimers()
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
    for (let index = 0; index < 3; index += 1) {
      client.emit('message', Buffer.alloc(0), true)
    }
    expect(budget.current()).toBe(3 * FRAME_OVERHEAD)

    host.bufferedAmount = 0
    vi.advanceTimersByTime(25)
    expect(host.sent).toHaveLength(3)
    expect(budget.current()).toBe(0)

    host.bufferedAmount = 1024 * 1024
    client.emit('message', Buffer.alloc(0), true)
    client.emit('message', Buffer.from('x'), true)
    expect(budget.current()).toBe(2 * FRAME_OVERHEAD + 1)
    client.close(1000, 'done')
    expect(budget.current()).toBe(0)
  })
})
