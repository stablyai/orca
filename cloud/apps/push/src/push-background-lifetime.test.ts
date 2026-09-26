import { afterEach, expect, it, vi } from 'vitest'
import { startPushBackground } from './push-background.js'
import { createPushServerHarness } from './push-server-harness.test-fixture.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it.each(['fulfilled', 'rejected'] as const)(
  'keeps each background prune pending until %s without accumulating queries',
  async (outcome) => {
    const harness = await createPushServerHarness()
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(harness.server.worker, 'start').mockImplementation(() => {})
    const pending = Promise.withResolvers<number>()
    const pruners = [
      vi.spyOn(harness.server.challenges, 'pruneExpired').mockReturnValue(pending.promise),
      vi.spyOn(harness.server.sessions, 'pruneExpired').mockReturnValue(pending.promise),
      vi.spyOn(harness.server.deliveryStore, 'prune').mockReturnValue(pending.promise)
    ]
    const stop = startPushBackground({ mode: 'active' }, harness.server)
    try {
      expect(vi.getTimerCount()).toBe(3)
      await vi.advanceTimersByTimeAsync(100 * 60_000)
      for (const prune of pruners) expect(prune).toHaveBeenCalledOnce()

      for (const prune of pruners) prune.mockResolvedValue(0)
      if (outcome === 'fulfilled') pending.resolve(0)
      else pending.reject(new Error('database unavailable'))
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      for (const prune of pruners) expect(prune.mock.calls.length).toBeGreaterThan(1)
      await stop()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      pending.resolve(0)
      await stop()
      await harness.close()
    }
  }
)
