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
