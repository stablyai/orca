import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  RelayDispatcher,
  type RelayClientSinkOptions,
  type SinkWriteSettlement
} from './dispatcher'
import {
  DISPATCHER_CONTROL_QUEUE_MAX_BYTES,
  DISPATCHER_CONTROL_QUEUE_MAX_FRAMES
} from './dispatcher-writer-admission'
import { LEGACY_CLIENT_RETAINED_BYTES_LOW } from './legacy-relay-publication-ledger'
import type * as ProtocolModule from './protocol'
import { encodeJsonRpcFrame, RelayErrorCode } from './protocol'

// Counts every frame encode (including the estimate-only ones) so a redundant re-encode is observable.
const encodeCalls = vi.hoisted(() => ({ count: 0 }))

vi.mock('./protocol', async (importOriginal) => {
  const actual = await importOriginal<typeof ProtocolModule>()
  return {
    ...actual,
    encodeJsonRpcFrame: (...args: Parameters<typeof actual.encodeJsonRpcFrame>) => {
      encodeCalls.count++
      return actual.encodeJsonRpcFrame(...args)
    }
  }
})

type BoundedClient = {
  frames: Buffer[]
  closes: number
  options: RelayClientSinkOptions
  write: (data: Buffer) => boolean
}

// Why: a sink that never accepts a write and never drains retains producer bytes, so the queue saturates
// while every individual frame stays comfortably inside the per-frame capacity.
function makeSaturatingClient(highWaterMark: number): BoundedClient {
  const client = makeBoundedClient(highWaterMark)
  client.write = (data: Buffer) => {
    client.frames.push(Buffer.from(data))
    return false
  }
  return client
}

type DrainableClient = BoundedClient & { drain: () => boolean }

// Why: a saturating sink that can be released one frame at a time, so queued frames become observable.
function makeDrainableSaturatingClient(highWaterMark: number): DrainableClient {
  const client = makeSaturatingClient(highWaterMark) as DrainableClient
  let pending: (() => void) | null = null
  client.options.waitWriteDrain = (callback) => {
    pending = callback
    return () => {
      if (pending === callback) {
        pending = null
      }
    }
  }
  client.drain = () => {
    const callback = pending
    pending = null
    callback?.()
    return callback !== null
  }
  return client
}

// Why: a real reattach replay is ANSI-dense, so JSON escaping inflates it well past its character count.
function makeAnsiReplay(chars: number): string {
  const cell = '\u001b[2K\u001b[1;32mhello\u001b[0m \r\n'
  return cell.repeat(Math.ceil(chars / cell.length)).slice(0, chars)
}

const OVER_CAPACITY_MESSAGE = 'Relay response exceeded the bounded transport capacity'
const CONTROL_PAD_METHOD = 'control.pad'

// Why: control admission is sized in encoded frame bytes, so pad a notification to an exact frame size.
function controlPadParams(frameBytes: number): { pad: string } {
  const empty = encodeJsonRpcFrame(
    { jsonrpc: '2.0', method: CONTROL_PAD_METHOD, params: { pad: '' } },
    0,
    0
  ).length
  return { pad: 'x'.repeat(frameBytes - empty) }
}

function fillControlLaneToByteBound(dispatcher: RelayDispatcher, clientId: number): void {
  const padFrameBytes = 64 * 1024
  const params = controlPadParams(padFrameBytes)
  for (let index = 0; index < DISPATCHER_CONTROL_QUEUE_MAX_BYTES / padFrameBytes; index += 1) {
    expect(
      dispatcher.tryNotifyClient(clientId, CONTROL_PAD_METHOD, params, () => {}, {
        controlOverflow: 'reject'
      })
    ).toBe(true)
  }
}

// A bare notification is smaller than the error substitute, so its rejection proves the substitute cannot
// fit either — anything that still gets through afterwards can only have come from the reserve.
function expectControlLaneFull(dispatcher: RelayDispatcher, clientId: number): void {
  expect(
    dispatcher.tryNotifyClient(clientId, 'control.probe', undefined, () => {}, {
      controlOverflow: 'reject'
    })
  ).toBe(false)
}

async function drainFully(client: DrainableClient, steps: number): Promise<void> {
  for (let step = 0; step < steps && client.drain(); step += 1) {
    await vi.advanceTimersByTimeAsync(0)
  }
}

function makeBoundedClient(highWaterMark: number): BoundedClient {
  const client: BoundedClient = {
    frames: [],
    closes: 0,
    write: (data: Buffer) => {
      client.frames.push(Buffer.from(data))
      return true
    },
    options: {
      writableHighWaterMark: () => highWaterMark,
      writableLength: () => 0,
      close: () => {
        client.closes++
      }
    }
  }
  return client
}

function decodePayload(frame: Buffer): Record<string, unknown> {
  const length = frame.readUInt32BE(9)
  return JSON.parse(frame.subarray(13, 13 + length).toString('utf-8'))
}

describe('RelayDispatcher bounded-capacity degradation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('producerEnvelopeBudget returns a negative budget for an over-cap envelope', () => {
    const primary = makeBoundedClient(16384)
    const bounded = new RelayDispatcher(primary.write, primary.options)
    try {
      expect(
        bounded.producerEnvelopeBudget('fs.changed', { events: ['x'.repeat(64)] })
      ).toBeGreaterThan(0)
      expect(
        bounded.producerEnvelopeBudget('fs.changed', { events: ['x'.repeat(20_000)] })
      ).toBeLessThan(0)
    } finally {
      bounded.dispose()
    }
  })

  it('producerEnvelopeBudget takes the smallest client capacity unless a client is named', () => {
    const primary = makeBoundedClient(65536)
    const secondary = makeBoundedClient(16384)
    const bounded = new RelayDispatcher(primary.write, primary.options)
    try {
      const secondaryId = bounded.attachClient(secondary.write, secondary.options)
      const params = { events: ['x'.repeat(64)] }
      const envelopeBytes = encodeJsonRpcFrame(
        { jsonrpc: '2.0', method: 'fs.changed', params },
        0,
        0
      ).length

      expect(bounded.activeClientIds()).toHaveLength(2)
      expect(bounded.producerEnvelopeBudget('fs.changed', params)).toBe(12288 - envelopeBytes)
      expect(
        bounded.producerEnvelopeBudget('fs.changed', params, bounded.activeClientIds()[0])
      ).toBe(49152 - envelopeBytes)
      expect(bounded.producerEnvelopeBudget('fs.changed', params, secondaryId)).toBe(
        12288 - envelopeBytes
      )
      expect(bounded.producerEnvelopeBudget('fs.changed', params, 999)).toBe(
        Number.MIN_SAFE_INTEGER
      )
    } finally {
      bounded.dispose()
    }
  })

  it('producerEnvelopeBudget reports no capacity for a named client that is gone', () => {
    const primary = makeBoundedClient(65536)
    const secondary = makeBoundedClient(65536)
    const bounded = new RelayDispatcher(primary.write, primary.options)
    try {
      const secondaryId = bounded.attachClient(secondary.write, secondary.options)
      const params = { events: ['x'.repeat(64)] }
      expect(bounded.producerEnvelopeBudget('fs.changed', params, secondaryId)).toBeGreaterThan(0)

      // A client that detached between activeClientIds() and publication must never look like it fits.
      bounded.detachClient(secondaryId)
      expect(bounded.producerEnvelopeBudget('fs.changed', params, secondaryId)).toBeLessThan(0)
      expect(bounded.producerEnvelopeBudget('fs.changed', params, 999)).toBeLessThan(0)
      // The no-target broadcast case still reports unbounded room.
      expect(bounded.producerEnvelopeBudget('fs.changed', params)).toBeGreaterThan(0)
    } finally {
      bounded.dispose()
    }
  })

  it('producerDataBudget keeps its pre-delegation value for a pty.data envelope', () => {
    const primary = makeBoundedClient(65536)
    const bounded = new RelayDispatcher(primary.write, primary.options)
    try {
      // Snapshot of the shipped formula: 49152-byte producer capacity minus the 96-byte empty-data frame.
      expect(bounded.producerDataBudget('pty.data', { ptyId: 'pty-7', seq: 42 })).toBe(49056)
      // A vanished client leaves no room for data at all.
      expect(bounded.producerDataBudget('pty.data', { ptyId: 'pty-7', seq: 42 }, 999)).toBe(0)
    } finally {
      bounded.dispose()
    }
  })

  it('producerDataBudget floors at zero when the envelope alone exceeds capacity', () => {
    const primary = makeBoundedClient(1030)
    const bounded = new RelayDispatcher(primary.write, primary.options)
    try {
      expect(bounded.producerDataBudget('pty.data', { ptyId: 'x'.repeat(4096) })).toBe(0)
    } finally {
      bounded.dispose()
    }
  })

  it('notify drops an over-capacity frame and keeps the client open', () => {
    const primary = makeBoundedClient(16384)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const bounded = new RelayDispatcher(primary.write, primary.options)
    try {
      bounded.notify('fs.changed', { events: ['x'.repeat(20_000)] })

      expect(primary.closes).toBe(0)
      expect(primary.frames).toHaveLength(0)
      expect(stderr).toHaveBeenCalledTimes(1)
      expect(stderr.mock.calls[0][0]).toMatch(
        /^\[relay\] Dropped fs\.changed \(\d+B > producer frame capacity 12288B\)\n$/
      )

      bounded.notify('pty.exit', { id: 'pty-1' })
      expect(primary.frames).toHaveLength(1)
      expect(decodePayload(primary.frames[0]).method).toBe('pty.exit')
    } finally {
      stderr.mockRestore()
      bounded.dispose()
    }
  })

  it('logs at most one drop per client generation', () => {
    const primary = makeBoundedClient(16384)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const bounded = new RelayDispatcher(primary.write, primary.options)
    try {
      const flood = { events: ['x'.repeat(20_000)] }
      bounded.notify('fs.changed', flood)
      bounded.notify('fs.changed', flood)
      expect(stderr).toHaveBeenCalledTimes(1)

      const reattached = makeBoundedClient(16384)
      bounded.setWrite(reattached.write, reattached.options)
      bounded.notify('fs.changed', flood)
      expect(stderr).toHaveBeenCalledTimes(2)
    } finally {
      stderr.mockRestore()
      bounded.dispose()
    }
  })

  it('distinguishes an over-capacity drop from a producer-queue-full drop on one client', () => {
    const primary = makeSaturatingClient(4 * 1024 * 1024)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const bounded = new RelayDispatcher(primary.write, primary.options)
    try {
      // The first 1.5MB frame is retained by the stalled sink; the second exceeds the 2MB producer queue.
      bounded.notify('fs.changed', { events: ['x'.repeat(1_500_000)] })
      expect(primary.frames).toHaveLength(1)
      bounded.notify('fs.changed', { events: ['x'.repeat(1_500_000)] })
      bounded.notify('fs.changed', { events: ['x'.repeat(5_000_000)] })

      expect(primary.closes).toBe(0)
      expect(stderr).toHaveBeenCalledTimes(2)
      expect(stderr.mock.calls[0][0]).toMatch(
        /^\[relay\] Dropped fs\.changed \(\d+B, producer queue full; frame capacity 4128768B\)\n$/
      )
      expect(stderr.mock.calls[1][0]).toMatch(
        /^\[relay\] Dropped fs\.changed \(\d+B > producer frame capacity 4128768B\)\n$/
      )

      // Both classifications stay one-per-generation once logged.
      bounded.notify('fs.changed', { events: ['x'.repeat(1_500_000)] })
      bounded.notify('fs.changed', { events: ['x'.repeat(5_000_000)] })
      expect(stderr).toHaveBeenCalledTimes(2)
    } finally {
      stderr.mockRestore()
      bounded.dispose()
    }
  })

  it('logs each dropped method once instead of letting the first method silence the rest', () => {
    const primary = makeBoundedClient(16384)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const bounded = new RelayDispatcher(primary.write, primary.options)
    try {
      const flood = { events: ['x'.repeat(20_000)] }
      bounded.notify('fs.changed', flood)
      bounded.notify('pty.data', flood)
      bounded.notify('fs.changed', flood)
      bounded.notify('pty.data', flood)

      expect(stderr).toHaveBeenCalledTimes(2)
      expect(stderr.mock.calls[0][0]).toContain('Dropped fs.changed')
      expect(stderr.mock.calls[1][0]).toContain('Dropped pty.data')
    } finally {
      stderr.mockRestore()
      bounded.dispose()
    }
  })

  it('publishProducerNotification publishes on the producer lane and never closes', () => {
    const primary = makeBoundedClient(65536)
    const secondary = makeBoundedClient(16384)
    const bounded = new RelayDispatcher(primary.write, primary.options)
    try {
      const secondaryId = bounded.attachClient(secondary.write, secondary.options)

      expect(bounded.publishProducerNotification(secondaryId, 'fs.changed', { events: [] })).toBe(
        true
      )
      expect(secondary.frames).toHaveLength(1)
      expect(primary.frames).toHaveLength(0)

      expect(
        bounded.publishProducerNotification(secondaryId, 'fs.changed', {
          events: ['x'.repeat(20_000)]
        })
      ).toBe(false)
      expect(secondary.closes).toBe(0)
      expect(secondary.frames).toHaveLength(1)

      expect(bounded.publishProducerNotification(999, 'fs.changed')).toBe(false)
    } finally {
      bounded.dispose()
    }
  })

  it('still closes on protocol-critical control queue overflow', () => {
    const primary = makeSaturatingClient(65536)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const bounded = new RelayDispatcher(primary.write, primary.options)
    try {
      const clientId = bounded.activeClientIds()[0]
      for (let index = 0; index < DISPATCHER_CONTROL_QUEUE_MAX_FRAMES; index += 1) {
        bounded.notifyClient(clientId, `control.${index}`)
      }
      expect(primary.closes).toBe(0)

      bounded.notifyClient(clientId, 'control.overflow')
      expect(primary.closes).toBe(1)
    } finally {
      stderr.mockRestore()
      bounded.dispose()
    }
  })

  it('closes the client when pty.replay overflows the control queue', () => {
    const primary = makeSaturatingClient(65536)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const bounded = new RelayDispatcher(primary.write, primary.options)
    try {
      const clientId = bounded.activeClientIds()[0]
      for (let index = 0; index < DISPATCHER_CONTROL_QUEUE_MAX_FRAMES; index += 1) {
        bounded.notifyClient(clientId, `control.${index}`)
      }
      expect(primary.closes).toBe(0)

      // Replay is never retried, so an unnoticed drop would strand the pane on a short buffer.
      bounded.notify('pty.replay', { paneKey: 'tab-1:pane-1', data: 'x' })
      expect(primary.closes).toBe(1)
    } finally {
      stderr.mockRestore()
      bounded.dispose()
    }
  })

  it('publishProducerNotification reports its drops like notify', () => {
    const primary = makeBoundedClient(65536)
    const secondary = makeBoundedClient(16384)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const bounded = new RelayDispatcher(primary.write, primary.options)
    try {
      const secondaryId = bounded.attachClient(secondary.write, secondary.options)
      const flood = { events: ['x'.repeat(20_000)] }

      expect(bounded.publishProducerNotification(secondaryId, 'fs.changed', flood)).toBe(false)
      expect(stderr).toHaveBeenCalledTimes(1)
      expect(stderr.mock.calls[0][0]).toMatch(
        /^\[relay\] Dropped fs\.changed \(\d+B > producer frame capacity 12288B\)\n$/
      )

      // Same one-line-per-generation budget as notify().
      expect(bounded.publishProducerNotification(secondaryId, 'fs.changed', flood)).toBe(false)
      expect(stderr).toHaveBeenCalledTimes(1)
    } finally {
      stderr.mockRestore()
      bounded.dispose()
    }
  })

  it('does not re-encode a dropped frame when its log line is suppressed', () => {
    const primary = makeBoundedClient(16384)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const bounded = new RelayDispatcher(primary.write, primary.options)
    try {
      const flood = { events: ['x'.repeat(20_000)] }
      bounded.notify('fs.changed', flood)
      expect(stderr).toHaveBeenCalledTimes(1)

      // The suppressed drop must size the frame once, not once to publish and again to log.
      encodeCalls.count = 0
      bounded.notify('fs.changed', flood)
      expect(stderr).toHaveBeenCalledTimes(1)
      expect(encodeCalls.count).toBe(1)
    } finally {
      stderr.mockRestore()
      bounded.dispose()
    }
  })

  it('sendResponse substitutes a JSON-RPC error instead of closing when the legacy lane rejects', async () => {
    const primary = makeBoundedClient(65536)
    const bounded = new RelayDispatcher(primary.write, primary.options)
    try {
      bounded.onRequest('fs.listFiles', async () => ({ paths: 'x'.repeat(3 * 1024 * 1024) }))
      bounded.feed(encodeJsonRpcFrame({ jsonrpc: '2.0', id: 77, method: 'fs.listFiles' }, 1, 0))
      await vi.advanceTimersByTimeAsync(0)

      expect(primary.closes).toBe(0)
      expect(primary.frames).toHaveLength(1)
      const response = decodePayload(primary.frames[0]) as unknown as {
        id: number
        error: { code: number; message: string }
      }
      expect(response.id).toBe(77)
      expect(response.error.code).toBe(RelayErrorCode.ResponseOverCapacity)
      expect(response.error.message).toBe('Relay response exceeded the bounded transport capacity')
    } finally {
      bounded.dispose()
    }
  })

  it('settles the response fence as failed when the substitute error replaces the result', async () => {
    const primary = makeBoundedClient(65536)
    const bounded = new RelayDispatcher(primary.write, primary.options)
    try {
      const settlements: SinkWriteSettlement[] = []
      bounded.onRequest('fs.listFiles', async (_params, context) => {
        context.onResponseSettled?.((result) => settlements.push(result))
        return { paths: 'x'.repeat(3 * 1024 * 1024) }
      })
      bounded.feed(encodeJsonRpcFrame({ jsonrpc: '2.0', id: 79, method: 'fs.listFiles' }, 1, 0))
      await vi.advanceTimersByTimeAsync(0)

      expect(primary.closes).toBe(0)
      expect(settlements).toHaveLength(1)
      // The peer got a capacity error, not the result — the fence must not claim delivery.
      expect(settlements[0]).toEqual({
        ok: false,
        error: new Error('Relay response exceeded the bounded transport capacity')
      })
    } finally {
      bounded.dispose()
    }
  })

  it('answers every reattach response instead of closing when the batch exceeds the control budget', async () => {
    const primary = makeDrainableSaturatingClient(65536)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const bounded = new RelayDispatcher(primary.write, primary.options)
    try {
      const replay = makeAnsiReplay(100 * 1024)
      bounded.onRequest('pty.attach', async () => ({ incarnationId: 'inc-1', replay }))
      for (let id = 1; id <= 8; id += 1) {
        bounded.feed(
          encodeJsonRpcFrame(
            {
              jsonrpc: '2.0',
              id,
              method: 'pty.attach',
              params: { id: `pty-${id}`, suppressReplayNotification: true }
            },
            id,
            0
          )
        )
      }
      await vi.advanceTimersByTimeAsync(0)

      // The reattach burst must degrade per request, never take the link down.
      expect(primary.closes).toBe(0)

      for (let step = 0; step < 64 && primary.drain(); step += 1) {
        await vi.advanceTimersByTimeAsync(0)
      }

      const responses = primary.frames.map(
        (frame) => decodePayload(frame) as unknown as { id: number; error?: { code: number } }
      )
      expect(responses.map((response) => response.id).sort((a, b) => a - b)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8
      ])
      expect(
        responses.filter((response) => response.error?.code === RelayErrorCode.ResponseOverCapacity)
          .length
      ).toBeGreaterThan(0)
      expect(primary.closes).toBe(0)
    } finally {
      stderr.mockRestore()
      bounded.dispose()
    }
  })

  it('answers from the control byte reserve when the lane is filled to the 1MiB bound', async () => {
    const primary = makeDrainableSaturatingClient(65536)
    const bounded = new RelayDispatcher(primary.write, primary.options)
    try {
      const clientId = bounded.activeClientIds()[0]
      // 16 x 64KiB lands controlBytes on the bound exactly while using only 16 of the 256 frame slots,
      // so the byte bound is the only thing that can reject the substitute.
      fillControlLaneToByteBound(bounded, clientId)
      expectControlLaneFull(bounded, clientId)

      bounded.onRequest('pty.attach', async () => ({
        incarnationId: 'inc-1',
        replay: makeAnsiReplay(4 * 1024)
      }))
      bounded.feed(encodeJsonRpcFrame({ jsonrpc: '2.0', id: 91, method: 'pty.attach' }, 1, 0))
      await vi.advanceTimersByTimeAsync(0)

      expect(primary.closes).toBe(0)

      await drainFully(primary, 64)
      const payloads = primary.frames.map((frame) => decodePayload(frame))
      expect(payloads.filter((payload) => payload.id === 91)).toEqual([
        {
          jsonrpc: '2.0',
          id: 91,
          error: { code: RelayErrorCode.ResponseOverCapacity, message: OVER_CAPACITY_MESSAGE }
        }
      ])
      expect(primary.closes).toBe(0)
    } finally {
      bounded.dispose()
    }
  })

  it('answers from the control frame reserve when all 256 frame slots are taken', async () => {
    const primary = makeDrainableSaturatingClient(65536)
    const bounded = new RelayDispatcher(primary.write, primary.options)
    try {
      const clientId = bounded.activeClientIds()[0]
      // Tiny frames leave the byte bound untouched, so only the frame bound can reject the substitute.
      for (let index = 0; index < DISPATCHER_CONTROL_QUEUE_MAX_FRAMES; index += 1) {
        expect(
          bounded.tryNotifyClient(clientId, `control.${index}`, undefined, () => {}, {
            controlOverflow: 'reject'
          })
        ).toBe(true)
      }
      expectControlLaneFull(bounded, clientId)

      bounded.onRequest('pty.attach', async () => ({ incarnationId: 'inc-1', replay: 'ok' }))
      bounded.feed(encodeJsonRpcFrame({ jsonrpc: '2.0', id: 92, method: 'pty.attach' }, 1, 0))
      await vi.advanceTimersByTimeAsync(0)

      expect(primary.closes).toBe(0)

      await drainFully(primary, DISPATCHER_CONTROL_QUEUE_MAX_FRAMES + 32)
      const payloads = primary.frames.map((frame) => decodePayload(frame))
      expect(payloads.filter((payload) => payload.id === 92)).toEqual([
        {
          jsonrpc: '2.0',
          id: 92,
          error: { code: RelayErrorCode.ResponseOverCapacity, message: OVER_CAPACITY_MESSAGE }
        }
      ])
      expect(primary.closes).toBe(0)
    } finally {
      bounded.dispose()
    }
  })

  it('settles a control-rejected response exactly once, when the reserved substitute is written', async () => {
    const primary = makeDrainableSaturatingClient(65536)
    const bounded = new RelayDispatcher(primary.write, primary.options)
    try {
      const clientId = bounded.activeClientIds()[0]
      fillControlLaneToByteBound(bounded, clientId)

      const settlements: SinkWriteSettlement[] = []
      bounded.onRequest('pty.attach', async (_params, context) => {
        context.onResponseSettled?.((result) => settlements.push(result))
        return { incarnationId: 'inc-1', replay: makeAnsiReplay(4 * 1024) }
      })
      bounded.feed(encodeJsonRpcFrame({ jsonrpc: '2.0', id: 93, method: 'pty.attach' }, 1, 0))
      await vi.advanceTimersByTimeAsync(0)

      // The reserve admitted the substitute, so the fence waits on its write instead of failing admission.
      expect(primary.closes).toBe(0)
      expect(settlements).toHaveLength(0)

      await drainFully(primary, 64)
      expect(settlements).toEqual([{ ok: false, error: new Error(OVER_CAPACITY_MESSAGE) }])
      expect(primary.closes).toBe(0)
    } finally {
      bounded.dispose()
    }
  })

  it('producerRetentionBelowLowWater reports the reserve of one client, not the dispatcher', () => {
    const stalled = makeSaturatingClient(65536)
    const healthy = makeBoundedClient(65536)
    const bounded = new RelayDispatcher(stalled.write, stalled.options)
    try {
      const stalledId = bounded.activeClientIds()[0]
      const healthyId = bounded.attachClient(healthy.write, healthy.options)
      let parked = 0
      while (
        parked <= LEGACY_CLIENT_RETAINED_BYTES_LOW &&
        bounded.publishProducerNotification(stalledId, 'pty.data', {
          paneId: 'pane',
          data: 'x'.repeat(40_000)
        })
      ) {
        parked += 40_000
      }
      expect(parked).toBeGreaterThan(LEGACY_CLIENT_RETAINED_BYTES_LOW)

      expect(bounded.producerRetentionBelowLowWater(stalledId)).toBe(false)
      expect(bounded.producerRetentionBelowLowWater(healthyId)).toBe(true)
      // The dispatcher-wide signal is the one that lets a stalled peer speak for a healthy client.
      expect(bounded.legacyRetentionBelowLowWater).toBe(false)

      // A client that cannot be written to has no headroom at all.
      expect(bounded.producerRetentionBelowLowWater(999)).toBe(false)
      bounded.detachClient(healthyId)
      expect(bounded.producerRetentionBelowLowWater(healthyId)).toBe(false)
    } finally {
      bounded.dispose()
    }
  })

  it('sendResponse settles an already-failed oversized response without closing', async () => {
    const primary = makeBoundedClient(65536)
    const bounded = new RelayDispatcher(primary.write, primary.options)
    try {
      bounded.onRequest('fs.listFiles', async () => {
        throw new Error('x'.repeat(3 * 1024 * 1024))
      })
      bounded.feed(encodeJsonRpcFrame({ jsonrpc: '2.0', id: 78, method: 'fs.listFiles' }, 1, 0))
      await vi.advanceTimersByTimeAsync(0)

      expect(primary.closes).toBe(0)
      expect(primary.frames).toHaveLength(1)
      const response = decodePayload(primary.frames[0]) as unknown as {
        id: number
        error: { code: number; message: string }
      }
      expect(response.id).toBe(78)
      expect(response.error.code).toBe(RelayErrorCode.ResponseOverCapacity)
      expect(response.error.message).toBe('Relay response exceeded the bounded transport capacity')
    } finally {
      bounded.dispose()
    }
  })
})
