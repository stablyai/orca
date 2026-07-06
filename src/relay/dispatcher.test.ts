import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { RelayDispatcher } from './dispatcher'
import {
  encodeJsonRpcFrame,
  encodeKeepAliveFrame,
  MessageType,
  type JsonRpcRequest,
  type JsonRpcNotification
} from './protocol'

function decodeFirstFrame(buf: Buffer): { type: number; id: number; ack: number; payload: Buffer } {
  const type = buf[0]
  const id = buf.readUInt32BE(1)
  const ack = buf.readUInt32BE(5)
  const len = buf.readUInt32BE(9)
  const payload = buf.subarray(13, 13 + len)
  return { type, id, ack, payload }
}

describe('RelayDispatcher', () => {
  let dispatcher: RelayDispatcher
  let written: Buffer[]

  beforeEach(() => {
    vi.useFakeTimers()
    written = []
    dispatcher = new RelayDispatcher((data) => {
      written.push(Buffer.from(data))
    })
  })

  afterEach(() => {
    dispatcher.dispose()
    vi.useRealTimers()
  })

  it('sends keepalive frames on interval', () => {
    expect(written.length).toBe(0)

    vi.advanceTimersByTime(5_000)
    expect(written.length).toBe(1)

    const frame = decodeFirstFrame(written[0])
    expect(frame.type).toBe(MessageType.KeepAlive)
    expect(frame.id).toBe(1)
  })

  it('dispatches JSON-RPC requests to registered handlers', async () => {
    const handler = vi.fn().mockResolvedValue({ result: 42 })
    dispatcher.onRequest('test.method', handler)

    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'test.method',
      params: { foo: 'bar' }
    }
    const frame = encodeJsonRpcFrame(req, 1, 0)
    dispatcher.feed(frame)

    // Let the handler promise resolve
    await vi.advanceTimersByTimeAsync(0)

    expect(handler).toHaveBeenCalledWith(
      { foo: 'bar' },
      expect.objectContaining({ isStale: expect.any(Function) })
    )

    // Should have sent a response (after keepalive timer writes)
    const responses = written.filter((buf) => {
      const f = decodeFirstFrame(buf)
      if (f.type !== MessageType.Regular) {
        return false
      }
      try {
        const msg = JSON.parse(f.payload.toString('utf-8'))
        return 'id' in msg && 'result' in msg
      } catch {
        return false
      }
    })
    expect(responses.length).toBe(1)

    const resp = JSON.parse(decodeFirstFrame(responses[0]).payload.toString('utf-8'))
    expect(resp.result).toEqual({ result: 42 })
    expect(resp.id).toBe(1)
  })

  it('sends error response when handler throws', async () => {
    dispatcher.onRequest('fail.method', async () => {
      throw new Error('boom')
    })

    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 5,
      method: 'fail.method'
    }
    dispatcher.feed(encodeJsonRpcFrame(req, 1, 0))
    await vi.advanceTimersByTimeAsync(0)

    const errors = written.filter((buf) => {
      const f = decodeFirstFrame(buf)
      if (f.type !== MessageType.Regular) {
        return false
      }
      try {
        const msg = JSON.parse(f.payload.toString('utf-8'))
        return 'error' in msg
      } catch {
        return false
      }
    })
    expect(errors.length).toBe(1)

    const resp = JSON.parse(decodeFirstFrame(errors[0]).payload.toString('utf-8'))
    expect(resp.error.message).toBe('boom')
    expect(resp.id).toBe(5)
  })

  it('sends method-not-found for unknown methods', async () => {
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 10,
      method: 'unknown.method'
    }
    dispatcher.feed(encodeJsonRpcFrame(req, 1, 0))
    await vi.advanceTimersByTimeAsync(0)

    const errors = written.filter((buf) => {
      const f = decodeFirstFrame(buf)
      if (f.type !== MessageType.Regular) {
        return false
      }
      try {
        const msg = JSON.parse(f.payload.toString('utf-8'))
        return msg.error?.code === -32601
      } catch {
        return false
      }
    })
    expect(errors.length).toBe(1)
  })

  it('dispatches notifications to registered handlers', () => {
    const handler = vi.fn()
    dispatcher.onNotification('event.happened', handler)

    const notif: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'event.happened',
      params: { x: 1 }
    }
    dispatcher.feed(encodeJsonRpcFrame(notif, 1, 0))

    expect(handler).toHaveBeenCalledWith(
      { x: 1 },
      expect.objectContaining({ clientId: 1, isStale: expect.any(Function) })
    )
  })

  it('sends notifications via notify()', () => {
    dispatcher.notify('my.event', { data: 'hello' })

    const notifs = written.filter((buf) => {
      const f = decodeFirstFrame(buf)
      if (f.type !== MessageType.Regular) {
        return false
      }
      try {
        const msg = JSON.parse(f.payload.toString('utf-8'))
        return 'method' in msg && !('id' in msg)
      } catch {
        return false
      }
    })
    expect(notifs.length).toBe(1)

    const msg = JSON.parse(decodeFirstFrame(notifs[0]).payload.toString('utf-8'))
    expect(msg.method).toBe('my.event')
    expect(msg.params).toEqual({ data: 'hello' })
  })

  it('broadcasts notifications to attached socket clients with independent frame state', () => {
    const socketWritten: Buffer[] = []
    const clientId = dispatcher.attachClient((data) => {
      socketWritten.push(Buffer.from(data))
    })

    dispatcher.notify('workspace.changed', { revision: 1 })

    expect(written).toHaveLength(1)
    expect(socketWritten).toHaveLength(1)
    expect(decodeFirstFrame(written[0]).id).toBe(1)
    expect(decodeFirstFrame(socketWritten[0]).id).toBe(1)

    dispatcher.detachClient(clientId)
    dispatcher.notify('workspace.changed', { revision: 2 })

    expect(written).toHaveLength(2)
    expect(socketWritten).toHaveLength(1)
  })

  it('forwards relay-originated requests to an owning socket client instead of the caller', async () => {
    dispatcher.invalidateClient()
    const ownerWritten: Buffer[] = []
    const ownerId = dispatcher.attachClient((data) => {
      ownerWritten.push(Buffer.from(data))
    })
    const cliId = dispatcher.attachClient(() => {})

    const pending = dispatcher.requestAnyClient(
      'orca.cli',
      { argv: ['status'] },
      { excludeClientId: cliId }
    )

    expect(ownerWritten).toHaveLength(1)
    const requestFrame = decodeFirstFrame(ownerWritten[0])
    const request = JSON.parse(requestFrame.payload.toString('utf-8')) as JsonRpcRequest
    expect(request.method).toBe('orca.cli')
    expect(request.params).toEqual({ argv: ['status'] })

    dispatcher.feedClient(
      ownerId,
      encodeJsonRpcFrame({ jsonrpc: '2.0', id: request.id, result: { exitCode: 0 } }, 1, 0)
    )

    await expect(pending).resolves.toEqual({ exitCode: 0 })
  })

  it('prefers an owning socket client over the synthetic primary client', async () => {
    const ownerWritten: Buffer[] = []
    const ownerId = dispatcher.attachClient((data) => {
      ownerWritten.push(Buffer.from(data))
    })
    const cliId = dispatcher.attachClient(() => {})

    const pending = dispatcher.requestAnyClient(
      'orca.cli',
      { argv: ['status'] },
      { excludeClientId: cliId }
    )

    expect(written).toHaveLength(0)
    expect(ownerWritten).toHaveLength(1)
    const requestFrame = decodeFirstFrame(ownerWritten[0])
    const request = JSON.parse(requestFrame.payload.toString('utf-8')) as JsonRpcRequest
    expect(request.method).toBe('orca.cli')

    dispatcher.feedClient(
      ownerId,
      encodeJsonRpcFrame({ jsonrpc: '2.0', id: request.id, result: { exitCode: 0 } }, 1, 0)
    )

    await expect(pending).resolves.toEqual({ exitCode: 0 })
  })

  it('isolates failed socket-client writes from other clients', () => {
    const goodSocketWritten: Buffer[] = []
    const failingClientId = dispatcher.attachClient(() => {
      throw new Error('socket closed')
    })
    dispatcher.attachClient((data) => {
      goodSocketWritten.push(Buffer.from(data))
    })

    dispatcher.notify('workspace.changed', { revision: 1 })
    dispatcher.notify('workspace.changed', { revision: 2 })

    expect(written).toHaveLength(2)
    expect(goodSocketWritten).toHaveLength(2)
    dispatcher.detachClient(failingClientId)
  })

  it('tracks highest received seq in ack field', async () => {
    const handler = vi.fn().mockResolvedValue('ok')
    dispatcher.onRequest('ping', handler)

    // Send request with seq=50
    const req: JsonRpcRequest = { jsonrpc: '2.0', id: 1, method: 'ping' }
    dispatcher.feed(encodeJsonRpcFrame(req, 50, 0))
    await vi.advanceTimersByTimeAsync(0)

    // The response frame should have ack=50
    const responseFrames = written.filter((buf) => {
      const f = decodeFirstFrame(buf)
      if (f.type !== MessageType.Regular) {
        return false
      }
      try {
        const msg = JSON.parse(f.payload.toString('utf-8'))
        return 'result' in msg
      } catch {
        return false
      }
    })
    expect(responseFrames.length).toBe(1)
    expect(decodeFirstFrame(responseFrames[0]).ack).toBe(50)
  })

  it('silently handles keepalive frames', () => {
    const frame = encodeKeepAliveFrame(1, 0)
    // Should not throw
    dispatcher.feed(frame)
  })

  it('stops sending after dispose', () => {
    dispatcher.dispose()
    const before = written.length
    dispatcher.notify('test', {})
    expect(written.length).toBe(before)

    vi.advanceTimersByTime(10_000)
    expect(written.length).toBe(before)
  })

  it('drops in-flight responses after client invalidation', async () => {
    let resolveHandler!: () => void
    const handler = vi.fn(
      (_params, context) =>
        new Promise((resolve) => {
          resolveHandler = () => resolve({ stale: context.isStale() })
        })
    )
    dispatcher.onRequest('slow.method', handler)

    const req: JsonRpcRequest = { jsonrpc: '2.0', id: 99, method: 'slow.method' }
    dispatcher.feed(encodeJsonRpcFrame(req, 1, 0))
    dispatcher.invalidateClient()
    resolveHandler()
    await vi.advanceTimersByTimeAsync(0)

    expect(handler).toHaveBeenCalled()
    const responses = written.filter((buf) => {
      const frame = decodeFirstFrame(buf)
      if (frame.type !== MessageType.Regular) {
        return false
      }
      const msg = JSON.parse(frame.payload.toString('utf-8'))
      return msg.id === 99
    })
    expect(responses).toHaveLength(0)
  })

  it('aborts in-flight request contexts after client invalidation', async () => {
    let observedSignal: AbortSignal | undefined
    let resolveHandler!: () => void
    dispatcher.onRequest(
      'slow.method',
      (_params, context) =>
        new Promise((resolve) => {
          observedSignal = context.signal
          resolveHandler = () => resolve(null)
        })
    )

    const req: JsonRpcRequest = { jsonrpc: '2.0', id: 100, method: 'slow.method' }
    dispatcher.feed(encodeJsonRpcFrame(req, 1, 0))
    await vi.advanceTimersByTimeAsync(0)
    dispatcher.invalidateClient()

    expect(observedSignal?.aborted).toBe(true)
    resolveHandler()
    await vi.advanceTimersByTimeAsync(0)
  })

  it('aborts in-flight request contexts on dispose', async () => {
    let observedSignal: AbortSignal | undefined
    let resolveHandler!: () => void
    dispatcher.onRequest(
      'slow.method',
      (_params, context) =>
        new Promise((resolve) => {
          observedSignal = context.signal
          resolveHandler = () => resolve(null)
        })
    )

    const req: JsonRpcRequest = { jsonrpc: '2.0', id: 101, method: 'slow.method' }
    dispatcher.feed(encodeJsonRpcFrame(req, 1, 0))
    await vi.advanceTimersByTimeAsync(0)
    dispatcher.dispose()

    expect(observedSignal?.aborted).toBe(true)
    resolveHandler()
    await vi.advanceTimersByTimeAsync(0)
  })

  it('notifies listeners when the primary client is invalidated', () => {
    const listener = vi.fn()
    dispatcher.onClientDetached(listener)

    dispatcher.invalidateClient()

    expect(listener).toHaveBeenCalledWith(1)
  })

  describe('notifyBulk (bulk lane backpressure)', () => {
    it('resolves immediately when the sink accepts the frame', async () => {
      const frames: Buffer[] = []
      const bulkDispatcher = new RelayDispatcher((data) => {
        frames.push(Buffer.from(data))
        return true
      })
      try {
        await bulkDispatcher.notifyBulk('bulk.event', { seq: 0 })
        expect(frames).toHaveLength(1)
        const frame = decodeFirstFrame(frames[0])
        const msg = JSON.parse(frame.payload.toString()) as JsonRpcNotification
        expect(msg.method).toBe('bulk.event')
      } finally {
        bulkDispatcher.dispose()
      }
    })

    it('holds the next bulk frame until the saturated sink drains', async () => {
      const frames: Buffer[] = []
      const drainWaiters = new Set<() => void>()
      const bulkDispatcher = new RelayDispatcher(
        (data) => {
          frames.push(Buffer.from(data))
          return false
        },
        { waitWriteDrain: (cb) => drainWaiters.add(cb) }
      )
      try {
        let firstSettled = false
        const first = bulkDispatcher.notifyBulk('bulk.event', { seq: 0 }).then(() => {
          firstSettled = true
        })
        void bulkDispatcher.notifyBulk('bulk.event', { seq: 1 })
        await vi.advanceTimersByTimeAsync(0)

        // First frame written, but its send has not settled and the second
        // frame is not admitted while the sink stays saturated.
        expect(frames).toHaveLength(1)
        expect(firstSettled).toBe(false)

        for (const cb of Array.from(drainWaiters)) {
          drainWaiters.delete(cb)
          cb()
        }
        await first
        await vi.advanceTimersByTimeAsync(0)
        expect(frames).toHaveLength(2)
      } finally {
        bulkDispatcher.dispose()
      }
    })

    it('interactive notify() frames are not gated behind a stalled bulk lane', async () => {
      const frames: Buffer[] = []
      const bulkDispatcher = new RelayDispatcher(
        (data) => {
          frames.push(Buffer.from(data))
          return false
        },
        { waitWriteDrain: () => {} }
      )
      try {
        void bulkDispatcher.notifyBulk('bulk.event', { seq: 0 })
        void bulkDispatcher.notifyBulk('bulk.event', { seq: 1 })
        await vi.advanceTimersByTimeAsync(0)
        expect(frames).toHaveLength(1)

        bulkDispatcher.notify('pty.data', { id: 'pty-1', data: 'x' })
        expect(frames).toHaveLength(2)
        const msg = JSON.parse(
          decodeFirstFrame(frames[1]).payload.toString()
        ) as JsonRpcNotification
        expect(msg.method).toBe('pty.data')
      } finally {
        bulkDispatcher.dispose()
      }
    })

    it('releases a parked bulk send when the dispatcher is disposed', async () => {
      const bulkDispatcher = new RelayDispatcher(() => false, { waitWriteDrain: () => {} })
      const pending = bulkDispatcher.notifyBulk('bulk.event', { seq: 0 })
      await vi.advanceTimersByTimeAsync(0)
      bulkDispatcher.dispose()
      await expect(pending).resolves.toBeUndefined()
    })

    it('targets only the requested client and resolves for missing clients', async () => {
      const primaryFrames: Buffer[] = []
      const secondaryFrames: Buffer[] = []
      const bulkDispatcher = new RelayDispatcher((data) => {
        primaryFrames.push(Buffer.from(data))
        return true
      })
      try {
        const secondaryId = bulkDispatcher.attachClient((data) => {
          secondaryFrames.push(Buffer.from(data))
          return true
        })

        await bulkDispatcher.notifyBulk('bulk.event', { seq: 0 }, { clientId: secondaryId })
        expect(primaryFrames).toHaveLength(0)
        expect(secondaryFrames).toHaveLength(1)

        await expect(
          bulkDispatcher.notifyBulk('bulk.event', { seq: 1 }, { clientId: 999 })
        ).resolves.toBeUndefined()
        expect(primaryFrames).toHaveLength(0)
        expect(secondaryFrames).toHaveLength(1)
      } finally {
        bulkDispatcher.dispose()
      }
    })
  })
})
