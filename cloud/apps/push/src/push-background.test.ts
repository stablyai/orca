import { afterEach, expect, it, vi } from 'vitest'
import { startPushBackground } from './push-background.js'
import { createPushServerHarness } from './push-server-harness.test-fixture.js'
import { reserveRequestConnection } from './push-background-database.js'
import { DurablePushStore, PRUNE_BATCH_ROWS } from './durable-push-store.js'
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
  const deliveries = vi.spyOn(runtime.deliveryStore, 'prune').mockResolvedValue(0)
  vi.spyOn(runtime.worker, 'start').mockImplementation(() => {})
  vi.useFakeTimers()
  const stop = startPushBackground({ mode }, runtime)
  cleanups.push(async () => {
    await stop()
    await harness.close()
  })
  return { stop, challenges, sessions, deliveries }
}

it('keeps one slow sweep per store while other stores keep their cadence', async () => {
  const h = await fixture()
  let finish!: (count: number) => void
  h.deliveries.mockImplementationOnce(() => new Promise<number>((resolve) => (finish = resolve)))
  try {
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(h.deliveries).toHaveBeenCalledTimes(1)
    expect(h.challenges).toHaveBeenCalledTimes(10)
    expect(h.sessions).toHaveBeenCalledTimes(1)
  } finally {
    finish(100_000)
  }
  await vi.advanceTimersByTimeAsync(60_000)
  expect(h.deliveries).toHaveBeenCalledTimes(2)
  await h.stop()
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  expect(h.deliveries).toHaveBeenCalledTimes(2)
  expect(h.challenges).toHaveBeenCalledTimes(11)
  expect(h.sessions).toHaveBeenCalledTimes(1)
})

it('releases a failed sweep so the next scheduled sweep can recover', async () => {
  const h = await fixture()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  h.deliveries.mockRejectedValueOnce(new Error('database unavailable'))
  await vi.advanceTimersByTimeAsync(60_000)
  expect(h.deliveries).toHaveBeenCalledTimes(1)
  expect(warn).toHaveBeenCalledWith(
    JSON.stringify({ event: 'orca_push_prune_failed', target: 'deliveries', error: 'Error' })
  )
  await vi.advanceTimersByTimeAsync(60_000)
  expect(h.deliveries).toHaveBeenCalledTimes(2)
  expect(warn).toHaveBeenCalledTimes(1)
})

it('keeps a delivery claim from queuing behind overlapping maintenance sweeps', async () => {
  const h = await fixture()
  let backlog = true
  const database: PushDatabase = {
    dialect: 'postgres',
    query: async (sql) => {
      if (!sql.startsWith('DELETE')) return []
      if (!backlog) return [{ changes: 0 }]
      await new Promise((resolve) => setTimeout(resolve, 4_000))
      return [{ changes: PRUNE_BATCH_ROWS }]
    },
    transaction: (operation) => operation(database),
    lockQuotaScope: async () => {},
    tryLockScope: async () => true,
    tryLockSharedScope: async () => true,
    close: async () => {}
  }
  const store = new DurablePushStore(database, Date.now, reserveRequestConnection(database, 2))
  const sweeps: Promise<number>[] = []
  h.deliveries.mockImplementation(() => {
    const sweep = store.prune()
    sweeps.push(sweep)
    return sweep
  })
  try {
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    const startedAt = Date.now()
    let claimDelay: number | undefined
    const claim = store.claim().then(() => {
      claimDelay = Date.now() - startedAt
    })
    await vi.advanceTimersByTimeAsync(44_000)
    await claim
    expect({ sweeps: sweeps.length, claimDelay }).toEqual({ sweeps: 1, claimDelay: 4_000 })
  } finally {
    await h.stop()
    backlog = false
    await vi.advanceTimersByTimeAsync(4_000)
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
