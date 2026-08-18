import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { RelayDispatcher, type SinkWriteSettlement } from './dispatcher'
import { relayWriterControlReserve } from './dispatcher-writer-admission'
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

  it('targets terminal ownership notifications to one attached client', () => {
    const firstWritten: Buffer[] = []
    const secondWritten: Buffer[] = []
    const firstId = dispatcher.attachClient((data) => {
      firstWritten.push(Buffer.from(data))
    })
    dispatcher.attachClient((data) => {
      secondWritten.push(Buffer.from(data))
    })

    dispatcher.notifyClient(firstId, 'fs.watchFailed', { watchId: 7 })

    expect(written).toHaveLength(0)
    expect(firstWritten).toHaveLength(1)
    expect(secondWritten).toHaveLength(0)
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

    // Why the cause is asserted: an unqualified invalidate is the relay's own decision, and only a
    // caller that watched the peer's transport end may report 'peer-closed'.
    expect(listener).toHaveBeenCalledWith(1, 'local')
  })

  it('detaches the primary client when its write throws (frame lost, trigger reconnect)', () => {
    // Regression: a primary-client write throw dropped the frame (possibly
    // pty.data/pty.exit) with no resend AND without notifying detach, so the
    // owning Orca's reconnect + PTY-reattach path never engaged until the ~20s
    // keepalive timeout — output/pane-death were silently lost in the meantime.
    let throwOnWrite = false
    const detachDispatcher = new RelayDispatcher((data) => {
      if (throwOnWrite) {
        throw new Error('socket closed')
      }
      written.push(Buffer.from(data))
    })
    try {
      const detachListener = vi.fn()
      detachDispatcher.onClientDetached(detachListener)

      // A frame the owning Orca must not silently miss (e.g. a pane exit).
      throwOnWrite = true
      detachDispatcher.notify('pty.exit', { id: 'pty-1', code: 0 })

      // Fix: the write failure detaches the primary so the reconnect/reattach
      // machinery runs promptly instead of waiting for keepalive timeout.
      // Why 'local': a throwing sink is this relay's write failing, not observed proof the peer left.
      expect(detachListener).toHaveBeenCalledWith(1, 'local')

      // Recovery: a reconnecting socket swaps the write via setWrite; the client
      // is usable again and later frames flow to the new sink.
      throwOnWrite = false
      const recovered: Buffer[] = []
      detachDispatcher.setWrite((data) => {
        recovered.push(Buffer.from(data))
      })
      detachDispatcher.notify('pty.data', { id: 'pty-1', data: 'x' })
      expect(recovered.length).toBeGreaterThan(0)
    } finally {
      detachDispatcher.dispose()
    }
  })

  it('aborts in-flight primary requests when a client write throws', () => {
    let throwOnWrite = false
    const detachDispatcher = new RelayDispatcher(() => {
      if (throwOnWrite) {
        throw new Error('socket closed')
      }
    })
    let requestSignal: AbortSignal | undefined
    try {
      detachDispatcher.onRequest('slow.method', async (_params, context) => {
        requestSignal = context.signal
        await new Promise<void>((resolve) => {
          context.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
      })
      detachDispatcher.feed(
        encodeJsonRpcFrame({ jsonrpc: '2.0', id: 9, method: 'slow.method' }, 1, 0)
      )

      expect(requestSignal?.aborted).toBe(false)
      throwOnWrite = true
      detachDispatcher.notify('pty.exit', { id: 'pty-1', code: 0 })

      expect(requestSignal?.aborted).toBe(true)
    } finally {
      detachDispatcher.dispose()
    }
  })

  it('preserves broadcast order when synchronous settlement re-enters production', () => {
    const primary: string[] = []
    const secondary: string[] = []
    const readData = (frame: Buffer): string => {
      const message = JSON.parse(decodeFirstFrame(frame).payload.toString()) as JsonRpcNotification
      return String(message.params?.data)
    }
    const orderedDispatcher = new RelayDispatcher((frame) => {
      primary.push(readData(frame))
      return true
    })
    orderedDispatcher.attachClient((frame) => {
      secondary.push(readData(frame))
      return true
    })
    let reentered = false
    orderedDispatcher.onLegacyPtyCapacity(() => {
      if (reentered) {
        return
      }
      reentered = true
      orderedDispatcher.tryNotifyPtyData({ id: 'pty-2', data: 'second' })
    })

    try {
      expect(orderedDispatcher.tryNotifyPtyData({ id: 'pty-1', data: 'first' })).toBe(true)
      expect(primary).toEqual(['first', 'second'])
      expect(secondary).toEqual(['first', 'second'])
    } finally {
      orderedDispatcher.dispose()
    }
  })

  it('does not retry accepted clients when a later broadcast member closes reentrantly', () => {
    const primary: string[] = []
    const secondary: string[] = []
    let secondaryId = 0
    const readData = (frame: Buffer): string => {
      const message = JSON.parse(decodeFirstFrame(frame).payload.toString()) as JsonRpcNotification
      return String(message.params?.data)
    }
    const dispatcher = new RelayDispatcher((frame) => {
      primary.push(readData(frame))
      if (secondaryId !== 0) {
        dispatcher.detachClient(secondaryId)
      }
      return true
    })
    secondaryId = dispatcher.attachClient((frame) => {
      secondary.push(readData(frame))
      return true
    })

    try {
      expect(dispatcher.tryNotifyPtyData({ id: 'pty-1', data: 'once' })).toBe(true)
      expect(primary).toEqual(['once'])
      expect(secondary).toEqual([])
    } finally {
      dispatcher.dispose()
    }
  })

  it('keeps a saturated legacy primary as required backpressure', () => {
    const callbacks: ((result: SinkWriteSettlement) => void)[] = []
    const legacyDispatcher = new RelayDispatcher(
      (_data, settle) => {
        callbacks.push(settle)
        return false
      },
      {
        supportsWriteCallback: true,
        writableLength: () => 128 * 1024,
        writableHighWaterMark: () => 4 * 1024 * 1024
      }
    )
    const detached = vi.fn()
    legacyDispatcher.onClientDetached(detached)
    const payload = 'x'.repeat(128 * 1024)
    let admitted = 0

    try {
      while (
        legacyDispatcher.tryNotifyPtyDataToMatchingClients(() => true, {
          id: 'pty-1',
          data: payload
        })
      ) {
        admitted++
      }

      expect(admitted).toBeGreaterThan(0)
      expect(admitted).toBeLessThan(20)
      expect(callbacks).toHaveLength(1)
      expect(detached).not.toHaveBeenCalled()
      expect(
        legacyDispatcher.tryNotifyPtyDataToMatchingClients(() => true, {
          id: 'pty-1',
          data: payload
        })
      ).toBe(false)
    } finally {
      legacyDispatcher.dispose()
    }
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
        {
          waitWriteDrain: (callback) => {
            drainWaiters.add(callback)
            return () => drainWaiters.delete(callback)
          }
        }
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

    it('does not write an interactive frame around a saturated bulk write', async () => {
      const frames: Buffer[] = []
      const drainWaiters = new Set<() => void>()
      const bulkDispatcher = new RelayDispatcher(
        (data) => {
          frames.push(Buffer.from(data))
          return false
        },
        {
          waitWriteDrain: (callback) => {
            drainWaiters.add(callback)
            return () => drainWaiters.delete(callback)
          }
        }
      )
      try {
        void bulkDispatcher.notifyBulk('bulk.event', { seq: 0 })
        void bulkDispatcher.notifyBulk('bulk.event', { seq: 1 })
        await vi.advanceTimersByTimeAsync(0)
        expect(frames).toHaveLength(1)

        bulkDispatcher.notify('pty.data', { id: 'pty-1', data: 'x' })
        expect(frames).toHaveLength(1)
        for (const callback of Array.from(drainWaiters)) {
          drainWaiters.delete(callback)
          callback()
        }
        await vi.advanceTimersByTimeAsync(0)
        expect(frames.length).toBeGreaterThanOrEqual(2)
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

  describe('legacy PTY chunk sizing', () => {
    type DispatcherInternals = {
      primaryClient: object
      estimateFrameBytes: (msg: JsonRpcNotification) => number
      prepareFrame: (msg: JsonRpcNotification) => object
      enqueueFrame: (
        client: object,
        msg: JsonRpcNotification,
        lane: string,
        onSettled?: (result: SinkWriteSettlement) => void
      ) => boolean
      enqueuePreparedFrame: (
        client: object,
        frame: object,
        lane: string,
        onSettled?: (result: SinkWriteSettlement) => void
      ) => boolean
    }

    // Pre-optimization sizing loop, kept verbatim for differential verification.
    function referenceMaxChars(
      capacities: number[],
      params: Record<string, unknown>,
      data: string,
      limit: number
    ): number {
      if (capacities.length === 0) {
        return Math.min(data.length, limit)
      }
      let low = 0
      let high = Math.min(data.length, limit)
      while (low < high) {
        const mid = Math.ceil((low + high) / 2)
        const msg: JsonRpcNotification = {
          jsonrpc: '2.0',
          method: 'pty.data',
          params: { ...params, data: data.slice(0, mid) }
        }
        const bytes = encodeJsonRpcFrame(msg, 0, 0).length
        if (capacities.every((capacity) => bytes <= capacity)) {
          low = mid
        } else {
          high = mid - 1
        }
      }
      return low
    }

    function makeDispatcher(highWaterMarks: number[]): {
      sized: RelayDispatcher
      capacities: number[]
    } {
      const [primaryHwm, ...rest] = highWaterMarks
      const sized = new RelayDispatcher(() => true, {
        writableHighWaterMark: () => primaryHwm,
        writableLength: () => 0
      })
      for (const hwm of rest) {
        sized.attachClient(() => true, {
          writableHighWaterMark: () => hwm,
          writableLength: () => 0
        })
      }
      return {
        sized,
        capacities: highWaterMarks.map((hwm) => Math.max(0, hwm - relayWriterControlReserve(hwm)))
      }
    }

    function mulberry32(seed: number): () => number {
      let a = seed
      return () => {
        a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }

    // Multi-byte UTF-8, astral pairs, lone surrogates, controls, quotes, and backslashes.
    const alphabet = 'aZ9 "\\\n\r\t éß€中𝄞😀𐀀�'

    it('matches the pre-optimization sizing loop across randomized inputs', () => {
      const random = mulberry32(0xc0ffee)
      const hwmChoices = [1030, 1100, 1250, 1400, 2048, 1024 * 1024]
      for (let trial = 0; trial < 300; trial++) {
        const length = Math.floor(random() * 240)
        let data = ''
        for (let i = 0; i < length; i++) {
          data += alphabet[Math.floor(random() * alphabet.length)]
        }
        const clientCount = 1 + Math.floor(random() * 2)
        const hwms = Array.from(
          { length: clientCount },
          () => hwmChoices[Math.floor(random() * hwmChoices.length)]
        )
        const params = { id: `pty-${trial}`, seq: trial }
        const { sized, capacities } = makeDispatcher(hwms)
        try {
          for (const limit of [0, 1, Math.floor(length / 2), length, length + 17]) {
            expect(sized.maxLegacyPtyDataChars(params, data, limit)).toBe(
              referenceMaxChars(capacities, params, data, limit)
            )
          }
          expect(sized.maxLegacyPtyDataChars(params, data)).toBe(
            referenceMaxChars(capacities, params, data, data.length)
          )
        } finally {
          sized.dispose()
        }
      }
    })

    it('sizes a chunk that fits every client with a single frame encode', () => {
      const { sized } = makeDispatcher([1024 * 1024])
      try {
        const spy = vi.spyOn(sized as unknown as DispatcherInternals, 'estimateFrameBytes')
        const data = 'x'.repeat(16 * 1024)
        expect(sized.maxLegacyPtyDataChars({ id: 'pty-1' }, data)).toBe(data.length)
        expect(spy).toHaveBeenCalledTimes(1)
      } finally {
        sized.dispose()
      }
    })

    it('publishes PTY data with a single frame preparation', () => {
      const frames: Buffer[] = []
      const publisher = new RelayDispatcher((data) => {
        frames.push(Buffer.from(data))
        return true
      })
      try {
        const spy = vi.spyOn(publisher as unknown as DispatcherInternals, 'prepareFrame')
        expect(publisher.tryNotifyPtyData({ id: 'pty-1', data: 'hello' })).toBe(true)
        expect(frames).toHaveLength(1)
        expect(spy).toHaveBeenCalledTimes(1)
      } finally {
        publisher.dispose()
      }
    })

    it('a prepared enqueue matches the composition wrapper', () => {
      const frames: Buffer[] = []
      const publisher = new RelayDispatcher((data) => {
        frames.push(Buffer.from(data))
        return true
      })
      try {
        const internals = publisher as unknown as DispatcherInternals
        const msg: JsonRpcNotification = {
          jsonrpc: '2.0',
          method: 'pty.data',
          params: { id: 'pty-1', data: 'héllo "𝄞"\\\n\uD800' }
        }
        expect(internals.enqueueFrame(internals.primaryClient, msg, 'ordinary')).toBe(true)
        expect(
          internals.enqueuePreparedFrame(
            internals.primaryClient,
            internals.prepareFrame(msg),
            'ordinary'
          )
        ).toBe(true)
        expect(frames).toHaveLength(2)
        expect(
          decodeFirstFrame(frames[1]).payload.equals(decodeFirstFrame(frames[0]).payload)
        ).toBe(true)
      } finally {
        publisher.dispose()
      }
    })

    it('a prepared enqueue rejects identically to the composition wrapper', () => {
      const { sized } = makeDispatcher([1030])
      try {
        const internals = sized as unknown as DispatcherInternals
        const msg: JsonRpcNotification = {
          jsonrpc: '2.0',
          method: 'pty.data',
          params: { id: 'pty-1', data: 'x'.repeat(512) }
        }
        expect(internals.enqueueFrame(internals.primaryClient, msg, 'ordinary')).toBe(false)
        expect(
          internals.enqueuePreparedFrame(
            internals.primaryClient,
            internals.prepareFrame(msg),
            'ordinary'
          )
        ).toBe(false)
      } finally {
        sized.dispose()
      }
    })
  })
})
