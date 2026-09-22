import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RelayAssignmentStore } from './assignment-store.js'
import type { RelayConfig } from './config.js'
import {
  combineRegionalRehomeSafety,
  REGIONAL_REHOME_RECONNECTS_PER_CELL_LIMIT,
  regionalRehomeSafetyFailure
} from './regional-rehome-safety.js'
import { startRegionalRehomeWorker } from './regional-rehome-worker.js'

describe('regional rehome worker', () => {
  afterEach(() => vi.restoreAllMocks())

  it('bounds empty polling to the six-second cadence and stops its timer', async () => {
    vi.useFakeTimers()
    const selectIdleRegionalRehomeCandidates = vi.fn().mockResolvedValue([])
    const worker = startRegionalRehomeWorker(config(), {
      selectIdleRegionalRehomeCandidates
    } as unknown as RelayAssignmentStore, {
      safetySnapshot: () => safety(Date.now()),
      random: () => 0
    })!
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(selectIdleRegionalRehomeCandidates).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(5_999)
      expect(selectIdleRegionalRehomeCandidates).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(selectIdleRegionalRehomeCandidates).toHaveBeenCalledTimes(2)
      worker.stop()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(selectIdleRegionalRehomeCandidates).toHaveBeenCalledTimes(2)
    } finally {
      worker.stop()
      vi.useRealTimers()
    }
  })

  it('passes unsafe process telemetry to the durable claim gate', async () => {
    let now = 0
    let sqlFailures = 0
    const selectIdleRegionalRehomeCandidates = vi.fn().mockResolvedValue([])
    const assignments = {
      selectIdleRegionalRehomeCandidates
    } as unknown as RelayAssignmentStore
    const worker = startRegionalRehomeWorker(config(), assignments, {
      now: () => now,
      safetySnapshot: () => ({ ...safety(now), sqlFailures }),
      intervalMs: 60_000
    })!
    await settleWorker()
    selectIdleRegionalRehomeCandidates.mockClear()
    now = 100
    sqlFailures = 1
    await worker.run()
    worker.stop()

    expect(selectIdleRegionalRehomeCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ observedAt: 100, sqlFailures: 1 })
    )
  })

  it('starts inert on directors so durable control can enable without a restart', async () => {
    let now = 0
    const selectIdleRegionalRehomeCandidates = vi.fn().mockResolvedValue([])
    const assignments = {
      selectIdleRegionalRehomeCandidates
    } as unknown as RelayAssignmentStore
    const worker = startRegionalRehomeWorker(config(), assignments, {
      now: () => now,
      safetySnapshot: () => safety(now),
      intervalMs: 60_000
    })
    expect(worker).not.toBeNull()
    await settleWorker()
    selectIdleRegionalRehomeCandidates.mockClear()
    now = 100
    await worker!.run()
    worker!.stop()
    expect(selectIdleRegionalRehomeCandidates).toHaveBeenCalledOnce()

    expect(
      startRegionalRehomeWorker(config({ role: 'cell' }), {} as RelayAssignmentStore, {
        safetySnapshot: () => safety(1)
      })
    ).toBeNull()
  })

  it('stops walking the page when the source names a deferral no candidate can pass', async () => {
    const fetchImpl = respondWith([{ outcome: 'deferred', reason: 'concurrency-limit' }])
    const summaries = collectSummaries()
    try {
      await runOnePoll(fetchImpl, 3, summaries)
    } finally {
      summaries.restore()
    }

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(summaries.entries).toEqual([
      {
        event: 'orca_relay_idle_rehome_dispatch_summary',
        candidates: 3,
        dispatched: 1,
        stoppedBy: 'concurrency-limit',
        outcomes: { 'deferred:concurrency-limit': 1 }
      }
    ])
  })

  it('keeps its whole-page walk when the source sends no reason at all', async () => {
    const fetchImpl = respondWith([{ outcome: 'deferred' }])
    const summaries = collectSummaries()
    try {
      await runOnePoll(fetchImpl, 3, summaries)
    } finally {
      summaries.restore()
    }

    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(summaries.entries[0]).toMatchObject({
      stoppedBy: null,
      outcomes: { deferred: 3 }
    })
  })

  it('walks past a deferral that only concerns the one candidate', async () => {
    const fetchImpl = respondWith([
      { outcome: 'deferred', reason: 'host-unsupported' },
      { outcome: 'busy' },
      { outcome: 'committed' }
    ])
    const summaries = collectSummaries()
    try {
      await runOnePoll(fetchImpl, 4, summaries)
    } finally {
      summaries.restore()
    }

    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(summaries.entries[0]).toMatchObject({
      dispatched: 3,
      stoppedBy: 'committed',
      outcomes: { 'deferred:host-unsupported': 1, busy: 1, committed: 1 }
    })
  })

  it('counts a source that answers with an error in the same summary', async () => {
    const cancel = vi.fn()
    const fetchImpl = vi.fn(async () =>
      new Response(new ReadableStream({ cancel }), { status: 503 })
    )
    const summaries = collectSummaries()
    try {
      await runOnePoll(fetchImpl, 2, summaries)
    } finally {
      summaries.restore()
    }

    expect(summaries.entries[0]).toMatchObject({ dispatched: 2, outcomes: { failed: 2 } })
    expect(cancel).toHaveBeenCalledTimes(2)
  })

  it('treats the reconnect threshold as per-cell and excludes the director', () => {
    const cells = 2
    const limit = cells * REGIONAL_REHOME_RECONNECTS_PER_CELL_LIMIT
    const processSafety = { ...safety(100), reconnects: limit * 10 }
    const fleetSafety = { ...safety(100), reconnects: limit }
    expect(
      regionalRehomeSafetyFailure(
        combineRegionalRehomeSafety(processSafety, fleetSafety),
        100,
        cells
      )
    ).toBeNull()
    expect(
      regionalRehomeSafetyFailure(
        combineRegionalRehomeSafety(processSafety, { ...fleetSafety, reconnects: limit + 1 }),
        100,
        cells
      )
    ).toBe('elevated_reconnects')
  })
})

// Answers each POST with the next scripted body, repeating the last one.
function respondWith(bodies: { outcome: string; reason?: string }[]) {
  let index = 0
  return vi.fn(async () => {
    const body = bodies[Math.min(index++, bodies.length - 1)]!
    return new Response(JSON.stringify({ v: 1, ...body }), {
      headers: { 'content-type': 'application/json' }
    })
  })
}

function collectSummaries() {
  const entries: Record<string, unknown>[] = []
  let arrived: (() => void) | undefined
  // The worker polls once the moment it is constructed, so the poll under test
  // is that one; `first` is how a test waits for it rather than for a tick.
  const first = new Promise<void>((resolve) => {
    arrived = resolve
  })
  const original = console.warn
  console.warn = (line: unknown, ...rest: unknown[]) => {
    try {
      const parsed = JSON.parse(line as string) as Record<string, unknown>
      if (parsed.event === 'orca_relay_idle_rehome_dispatch_summary') {
        entries.push(parsed)
        arrived?.()
        return
      }
    } catch {
      // Not a JSON log line; fall through to the original writer.
    }
    original(line as string, ...rest)
  }
  return { entries, first, restore: () => (console.warn = original) }
}

async function runOnePoll(
  fetchImpl: typeof fetch,
  candidates: number,
  summaries: { first: Promise<void> }
): Promise<void> {
  const assignments = {
    selectIdleRegionalRehomeCandidates: vi.fn(async () =>
      Array.from({ length: candidates }, (_, index) => ({
        v: 1 as const,
        attemptId: `00000000-0000-4000-8000-00000000000${index}`,
        userId: `user-${index}`,
        relayHostId: 'abcdefghijklmnop',
        sourceCellId: 'us-c1',
        sourceCellUrl: 'https://us-c1.relay.example.test',
        sourceCellIncarnation: '11111111-1111-4111-8111-111111111111',
        sourceAssignmentEpoch: 1,
        sourceGeneration: 1,
        targetCellId: 'asia-c1'
      }))
    )
  } as unknown as RelayAssignmentStore
  const worker = startRegionalRehomeWorker(config(), assignments, {
    fetch: fetchImpl,
    identityToken: async () => 'token',
    safetySnapshot: () => safety(Date.now()),
    intervalMs: 60_000
  })!
  try {
    await summaries.first
  } finally {
    worker.stop()
  }
}

function config(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    role: 'director',
    rehomeAudience: 'https://relay.example.test/v1/admin/host-drain',
    rehomeDirectorServiceAccount: 'relay-director@example.test',
    ...overrides
  } as RelayConfig
}

function safety(observedAt: number) {
  return {
    requiredCells: 2,
    missingCells: 0,
    observedAt,
    sqlFailures: 0,
    reconnects: 0,
    controlActivityRecoveryFailures: 0,
    databasePoolTotal: 3,
    databasePoolIdle: 3,
    databasePoolWaiting: 0,
    databasePoolWaitersMax: 0,
    databasePoolOldestWaitMs: 0,
    databasePoolWaitMsMax: 0
  }
}

async function settleWorker(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
