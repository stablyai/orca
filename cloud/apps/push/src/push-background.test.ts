import { afterEach, expect, it, vi } from 'vitest'
import { startPushBackground } from './push-background.js'
import { createPushServerHarness } from './push-server-harness.test-fixture.js'
import { reserveRequestConnection } from './push-background-database.js'
import { DurablePushStore, PRUNE_BATCH_ROWS, type PushPruneSweep } from './durable-push-store.js'
import type { PushDatabase } from './push-database.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function fixture(mode: 'active' | 'validation' = 'active') {
  const harness = await createPushServerHarness()
  const runtime = harness.server
  const challenges = vi.spyOn(runtime.challenges, 'pruneExpired').mockResolvedValue(0)
  const sessions = vi.spyOn(runtime.sessions, 'pruneExpired').mockResolvedValue(0)
  const deliveries = vi
    .spyOn(runtime.deliveryStore, 'prune')
    .mockResolvedValue({ deleted: 0, saturated: false })
  vi.spyOn(runtime.worker, 'start').mockImplementation(() => {})
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.useFakeTimers()
  const stop = startPushBackground({ mode }, runtime)
  cleanups.push(async () => {
    await stop()
    await harness.close()
  })
  return { stop, challenges, sessions, deliveries, warn }
}

it('keeps one slow sweep per store while other stores keep their cadence', async () => {
  const h = await fixture()
  let finish!: (sweep: PushPruneSweep) => void
  h.deliveries.mockImplementationOnce(
    () => new Promise<PushPruneSweep>((resolve) => (finish = resolve))
  )
  try {
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(h.deliveries).toHaveBeenCalledTimes(1)
    expect(h.challenges).toHaveBeenCalledTimes(10)
    expect(h.sessions).toHaveBeenCalledTimes(1)
  } finally {
    finish({ deleted: 100_000, saturated: false })
  }
  await vi.advanceTimersByTimeAsync(60_000)
  expect(h.deliveries).toHaveBeenCalledTimes(2)
  await h.stop()
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  expect(h.deliveries).toHaveBeenCalledTimes(2)
  expect(h.challenges).toHaveBeenCalledTimes(11)
  expect(h.sessions).toHaveBeenCalledTimes(1)
})

it('reports a sweep that is still running a full interval after it started', async () => {
  const h = await fixture()
  let finish!: (sweep: PushPruneSweep) => void
  h.deliveries.mockImplementationOnce(
    () => new Promise<PushPruneSweep>((resolve) => (finish = resolve))
  )
  try {
    await vi.advanceTimersByTimeAsync(119_999)
    expect(h.warn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(h.warn).toHaveBeenCalledWith(
      JSON.stringify({ event: 'orca_push_prune_overdue', target: 'deliveries' })
    )
  } finally {
    finish({ deleted: 0, saturated: false })
  }
  // One report per sweep: the settled sweep clears its own watchdog.
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  expect(h.warn).toHaveBeenCalledTimes(1)
})

it('releases a failed sweep so the next scheduled sweep can recover', async () => {
  const h = await fixture()
  h.deliveries.mockRejectedValueOnce(new Error('database unavailable'))
  await vi.advanceTimersByTimeAsync(60_000)
  expect(h.deliveries).toHaveBeenCalledTimes(1)
  expect(h.warn).toHaveBeenCalledWith(
    JSON.stringify({ event: 'orca_push_prune_failed', target: 'deliveries', error: 'Error' })
  )
  await vi.advanceTimersByTimeAsync(60_000)
  expect(h.deliveries).toHaveBeenCalledTimes(2)
  expect(h.warn).toHaveBeenCalledTimes(1)
})

it('resumes a saturated sweep at once rather than waiting out the interval', async () => {
  const h = await fixture()
  let backlogSweeps = 3
  h.deliveries.mockImplementation(async () => {
    const saturated = backlogSweeps-- > 0
    return { deleted: saturated ? PRUNE_BATCH_ROWS : 0, saturated }
  })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(h.deliveries).toHaveBeenCalledTimes(1)
  // Three saturated sweeps resume within milliseconds instead of costing an interval each.
  await vi.advanceTimersByTimeAsync(10)
  expect(h.deliveries).toHaveBeenCalledTimes(4)
  await vi.advanceTimersByTimeAsync(59_000)
  expect(h.deliveries).toHaveBeenCalledTimes(4)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(h.deliveries).toHaveBeenCalledTimes(5)
})

it('keeps a delivery claim behind one statement while a backlog drains back to back', async () => {
  const h = await fixture()
  let backlog = true
  let finishedDeletes = 0
  const database: PushDatabase = {
    dialect: 'postgres',
    query: async (sql) => {
      if (!sql.startsWith('DELETE')) return []
      await new Promise((resolve) => setTimeout(resolve, 4_000))
      finishedDeletes++
      // Only deliveries hold a backlog, so each sweep spends its whole budget there and returns.
      if (!backlog || !sql.includes('push_delivery_batches')) return [{ changes: 0 }]
      return [{ changes: PRUNE_BATCH_ROWS }]
    },
    transaction: (operation) => operation(database),
    lockQuotaScope: async () => {},
    tryLockScope: async () => true,
    tryLockSharedScope: async () => true,
    close: async () => {}
  }
  const store = new DurablePushStore(database, Date.now, reserveRequestConnection(database, 2))
  const sweeps: Promise<PushPruneSweep>[] = []
  let inFlight = 0
  let concurrentSweeps = 0
  h.deliveries.mockImplementation(() => {
    concurrentSweeps = Math.max(concurrentSweeps, ++inFlight)
    const sweep = store.prune().finally(() => void inFlight--)
    sweeps.push(sweep)
    return sweep
  })
  try {
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    const queuedAt = finishedDeletes
    const startedAt = Date.now()
    let statementsAhead: number | undefined
    let claimDelay: number | undefined
    const claim = store.claim().then(() => {
      statementsAhead = finishedDeletes - queuedAt
      claimDelay = Date.now() - startedAt
    })
    await vi.advanceTimersByTimeAsync(44_000)
    await claim
    // Sweeping serially parks one statement ahead of the claim no matter how long the drain runs.
    expect({ statementsAhead, concurrentSweeps }).toEqual({
      statementsAhead: 1,
      concurrentSweeps: 1
    })
    expect(claimDelay).toBeLessThanOrEqual(4_000)
    // Each sweep exhausts its 50-batch budget, so the drain continues instead of idling out the tick.
    expect(sweeps.length).toBeGreaterThan(1)
  } finally {
    await h.stop()
    backlog = false
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await Promise.all(sweeps)
  }
})

it('keeps validation mode free of sweeps and timers', async () => {
  const h = await fixture('validation')
  await vi.advanceTimersByTimeAsync(20 * 60_000)
  expect(h.challenges).not.toHaveBeenCalled()
  expect(h.sessions).not.toHaveBeenCalled()
  expect(h.deliveries).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
