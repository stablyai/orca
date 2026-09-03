import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import {
  ProcessQueuedByteBudget,
  wireSplice,
  type SpliceCloseInfo
} from './splice-forwarder.js'

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

  it('hard-closes a wedged splice and releases its global queued-byte reservation', () => {
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
    expect(budget.current()).toBe(8 * 1024 * 1024)
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

  it('queues one full catalog-sized frame for a backpressured peer without closing', async () => {
    // Why: the desktop's worktree catalog response exceeds 1MiB on large
    // workspaces; a single maxFrameBytes frame must survive backpressure.
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
    client.emit('message', Buffer.alloc(8 * 1024 * 1024), true)
    expect(client.closes).toEqual([])
    expect(host.closes).toEqual([])
    expect(budget.current()).toBe(8 * 1024 * 1024)

    // Peer drains; the queued frame flushes and the reservation releases.
    host.bufferedAmount = 0
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(host.sent.some((frame) => (frame.data as Buffer).byteLength === 8 * 1024 * 1024)).toBe(
      true
    )
    expect(budget.current()).toBe(0)
    expect(onClose).not.toHaveBeenCalled()
  })
})
