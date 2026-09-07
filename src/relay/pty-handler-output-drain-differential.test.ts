import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const { mockPtySpawn, mockPtyInstance } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockPtyInstance: {
    pid: process.pid,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))

vi.mock('node-pty', () => ({ spawn: mockPtySpawn }))

import { PtyHandler } from './pty-handler'
import type { RelayDispatcher } from './dispatcher'

// Mirrors the relay drain constants; kept local so a constant change fails this oracle loudly.
const CHUNK_CHARS = 16 * 1024
const MAX_WRITES = 2
const BATCH_INTERVAL_MS = 8
const DRAIN_CONTINUE_MS = 1

type PendingOutput = { data: string; rawLength?: number; seq?: number }
type DataEvent = { id: string; data: string; seq?: number; rawLength?: number }

/**
 * The pre-optimization implementation, verbatim in behavior: snapshot the whole pending map each
 * tick, then consume up to MAX_WRITES from that frozen list. The bounded-prefix capture must match
 * it event-for-event — including which entry leads each tick.
 */
function legacyFlushTick(pendingById: Map<string, PendingOutput>): {
  events: DataEvent[]
  writes: number
  reschedules: boolean
} {
  const events: DataEvent[] = []
  let writes = 0
  for (const [id, pending] of Array.from(pendingById.entries())) {
    if (writes >= MAX_WRITES) {
      break
    }
    pendingById.delete(id)
    const chunk = pending.data.slice(0, CHUNK_CHARS)
    const remaining = pending.data.slice(CHUNK_CHARS)
    if (remaining) {
      pendingById.set(id, {
        data: remaining,
        ...(pending.rawLength === undefined ? {} : { rawLength: remaining.length }),
        seq: pending.seq
      })
    }
    events.push({
      id,
      data: chunk,
      ...(pending.seq === undefined
        ? {}
        : { seq: pending.seq - (pending.data.length - chunk.length) }),
      ...(pending.rawLength === undefined ? {} : { rawLength: chunk.length })
    })
    writes += 1
  }
  return { events, writes, reschedules: pendingById.size > 0 && writes > 0 }
}

function legacyTimeline(initial: Map<string, PendingOutput>): DataEvent[] {
  const pendingById = new Map(initial)
  const timeline: DataEvent[] = []
  for (let tick = 0; tick < 500 && pendingById.size > 0; tick++) {
    const result = legacyFlushTick(pendingById)
    timeline.push(...result.events)
    if (!result.reschedules) {
      break
    }
  }
  return timeline
}

// xorshift32 — deterministic across platforms, no Math.random.
function createRandom(seed: number): () => number {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0x1_0000_0000
  }
}

describe('relay PTY output drain — differential vs the pre-optimization snapshot loop', () => {
  let dispatcher: {
    notify: ReturnType<typeof vi.fn>
    callRequest: (method: string, params?: Record<string, unknown>) => Promise<unknown>
    _notifications: { method: string; params?: Record<string, unknown> }[]
  }
  let handler: PtyHandler
  let dataCallbacks: Map<string, (data: string) => void>
  let exitCallbacks: Map<string, (event: { exitCode: number }) => void>
  let onNotifyData: ((frame: { id: string; data: string }) => void) | null

  beforeEach(() => {
    vi.useFakeTimers()
    mockPtySpawn.mockReset()
    dataCallbacks = new Map()
    exitCallbacks = new Map()
    onNotifyData = null

    const requestHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>()
    const notifications: { method: string; params?: Record<string, unknown> }[] = []
    let reentering = false
    dispatcher = {
      notify: vi.fn((method: string, params?: Record<string, unknown>) => {
        notifications.push({ method, params })
        if (method !== 'pty.data' || !onNotifyData || reentering) {
          return
        }
        // Why: the relay sink is a synchronous write; this hook models a sink that re-enters
        // PTY ingress before the drain returns.
        reentering = true
        try {
          onNotifyData(params as unknown as { id: string; data: string })
        } finally {
          reentering = false
        }
      }),
      callRequest: async (method: string, params: Record<string, unknown> = {}) => {
        const h = requestHandlers.get(method)
        if (!h) {
          throw new Error(`No handler for ${method}`)
        }
        return h(params)
      },
      _notifications: notifications
    }
    const full = {
      onRequest: vi.fn((method: string, h: (params: Record<string, unknown>) => Promise<unknown>) =>
        requestHandlers.set(method, h)
      ),
      onNotification: vi.fn(),
      notify: dispatcher.notify
    }
    handler = new PtyHandler(full as unknown as RelayDispatcher)
  })

  afterEach(async () => {
    onNotifyData = null
    const cleanup = handler.dispose({ waitForPhysicalExit: false })
    await vi.runAllTimersAsync()
    await cleanup.catch(() => {})
    vi.useRealTimers()
  })

  async function spawnPtys(count: number): Promise<string[]> {
    const ids: string[] = []
    for (let i = 0; i < count; i++) {
      let dataCallback!: (data: string) => void
      let exitCallback!: (event: { exitCode: number }) => void
      mockPtySpawn.mockReturnValueOnce({
        ...mockPtyInstance,
        onData: vi.fn((cb: (data: string) => void) => {
          dataCallback = cb
        }),
        onExit: vi.fn((cb: (event: { exitCode: number }) => void) => {
          exitCallback = cb
        })
      })
      const spawned = (await dispatcher.callRequest('pty.spawn', {})) as { id: string }
      dataCallbacks.set(spawned.id, dataCallback)
      exitCallbacks.set(spawned.id, exitCallback)
      ids.push(spawned.id)
    }
    return ids
  }

  function recordedDataEvents(): DataEvent[] {
    return dispatcher._notifications
      .filter((n) => n.method === 'pty.data')
      .map((n) => n.params as unknown as DataEvent)
  }

  it('emits the same pty.data timeline as the snapshot loop for multi-PTY multi-chunk drains', async () => {
    const sessionCount = 4
    const ids = await spawnPtys(sessionCount)

    const payloads = new Map<string, string>()
    const expectedPending = new Map<string, PendingOutput>()
    ids.forEach((id, index) => {
      // Vary chunk counts so PTYs finish on different ticks.
      const data = `${String.fromCharCode(97 + index)}`.repeat(CHUNK_CHARS * (index + 1) + index)
      payloads.set(id, data)
      expectedPending.set(id, { data })
    })

    for (const id of ids) {
      dataCallbacks.get(id)!(payloads.get(id)!)
    }

    await vi.advanceTimersByTimeAsync(BATCH_INTERVAL_MS)
    for (let tick = 0; tick < 200; tick++) {
      await vi.advanceTimersByTimeAsync(DRAIN_CONTINUE_MS)
    }

    expect(recordedDataEvents()).toEqual(legacyTimeline(expectedPending))
  })

  it('matches the snapshot loop across randomized session counts and payload sizes', async () => {
    const random = createRandom(0x5eed)
    const sessionCount = 5
    const ids = await spawnPtys(sessionCount)

    const expectedPending = new Map<string, PendingOutput>()
    for (const id of ids) {
      const chunks = 1 + Math.floor(random() * 3)
      const extra = Math.floor(random() * 64)
      const data = 'z'.repeat(CHUNK_CHARS * chunks + extra)
      expectedPending.set(id, { data })
      dataCallbacks.get(id)!(data)
    }

    await vi.advanceTimersByTimeAsync(BATCH_INTERVAL_MS)
    for (let tick = 0; tick < 300; tick++) {
      await vi.advanceTimersByTimeAsync(DRAIN_CONTINUE_MS)
    }

    expect(recordedDataEvents()).toEqual(legacyTimeline(expectedPending))
  })

  it('keeps one write per tick when a single PTY drains — pacing a lazy iterator walk breaks', async () => {
    const [id] = await spawnPtys(1)
    const first = 'x'.repeat(CHUNK_CHARS)
    dataCallbacks.get(id)!(`${first}tail`)

    await vi.advanceTimersByTimeAsync(BATCH_INTERVAL_MS)
    // Iterating the live map lazily would pick the re-queued remainder up again in this same tick.
    expect(recordedDataEvents()).toEqual([{ id, data: first }])

    await vi.advanceTimersByTimeAsync(DRAIN_CONTINUE_MS)
    expect(recordedDataEvents()).toEqual([
      { id, data: first },
      { id, data: 'tail' }
    ])
  })

  it('writes at most two PTYs per tick and rotates the rest to the next tick', async () => {
    const ids = await spawnPtys(3)
    for (const id of ids) {
      dataCallbacks.get(id)!('a'.repeat(CHUNK_CHARS + 4))
    }

    await vi.advanceTimersByTimeAsync(BATCH_INTERVAL_MS)
    // First tick writes the two head PTYs only.
    expect(recordedDataEvents().map((event) => event.id)).toEqual([ids[0], ids[1]])

    await vi.advanceTimersByTimeAsync(DRAIN_CONTINUE_MS)
    // Third PTY leads the next tick; the two re-queued remainders sit behind it.
    expect(recordedDataEvents().map((event) => event.id)).toEqual([ids[0], ids[1], ids[2], ids[0]])
  })

  it('freezes the tick batch before the first send, matching the snapshot loop under re-entrancy', async () => {
    const ids = await spawnPtys(2)
    dataCallbacks.get(ids[0])!('first')
    dataCallbacks.get(ids[1])!('second')

    // Append to the second PTY while the first is being sent. Capturing the batch up front freezes
    // the same values the whole-map snapshot froze, so this tick's output is unchanged.
    onNotifyData = (frame) => {
      if (frame.id === ids[0]) {
        dataCallbacks.get(ids[1])!('-appended')
      }
    }

    await vi.advanceTimersByTimeAsync(BATCH_INTERVAL_MS)
    expect(recordedDataEvents()).toEqual([
      { id: ids[0], data: 'first' },
      { id: ids[1], data: 'second' }
    ])

    onNotifyData = null
    await vi.advanceTimersByTimeAsync(BATCH_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(BATCH_INTERVAL_MS)
    // Verbatim pre-change behavior, quirk included: the frozen entry is sent and then deleted, so
    // bytes appended to it mid-tick are dropped. Reachable only from a sink that re-enters PTY
    // ingress synchronously; the relay's real sinks are stdout/socket writes that cannot. Asserted
    // here so the optimization is pinned to "no behavior change" rather than a silent improvement.
    expect(recordedDataEvents()).toEqual([
      { id: ids[0], data: 'first' },
      { id: ids[1], data: 'second' }
    ])
  })

  it('flushes pending bytes before pty.exit', async () => {
    // PTY exit routes through flushPtyOutput (the whole-entry path), not the chunked drain.
    const [id] = await spawnPtys(1)
    dataCallbacks.get(id)!('tail bytes')
    exitCallbacks.get(id)!({ exitCode: 0 })

    const methods = dispatcher._notifications.map((n) => n.method)
    // Ordering invariant: buffered output must land before the exit frame.
    expect(methods.indexOf('pty.data')).toBeGreaterThanOrEqual(0)
    expect(methods.indexOf('pty.data')).toBeLessThan(methods.indexOf('pty.exit'))

    const dataFrames = dispatcher._notifications.filter((n) => n.method === 'pty.data')
    expect(dataFrames).toHaveLength(1)
    expect(dataFrames[0].params).toEqual({ id, data: 'tail bytes' })
  })
})
