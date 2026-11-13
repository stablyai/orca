import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayHostOfflineStreak } from './relay-host-offline-streak'
import { RelayDialAbortedError } from './mobile-relay-director-fallback'
import { RelayOuterError } from '../encryption/mobile-relay-e2ee-link'

const hostOffline = () => new RelayOuterError(4404)
const attachTimeout = () => new RelayOuterError(4404, false, 'attach-timeout')

describe('RelayHostOfflineStreak', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  // 4404 retries are paced 5-15s; use 10s.
  function resolvesOver(ms: number, streak: RelayHostOfflineStreak): number {
    let resolves = 0
    for (let elapsed = 0; elapsed < ms; elapsed += 10_000) {
      resolves += streak.shouldResolve(hostOffline()) ? 1 : 0
      vi.advanceTimersByTime(10_000)
    }
    return resolves
  }

  it('resolves on the second 4404, then backs off for a desktop that stays offline', () => {
    const streak = new RelayHostOfflineStreak(() => null)
    expect(streak.shouldResolve(hostOffline())).toBe(false)
    expect(streak.shouldResolve(hostOffline())).toBe(true)
    // At most once per 5 minutes, and only at the 4th, 8th, 16th... 4404 of the episode.
    expect(resolvesOver(5 * 60_000 - 10_000, streak)).toBe(0)
    const hour = resolvesOver(60 * 60_000, streak)
    expect(hour).toBeGreaterThan(0)
    expect(hour).toBeLessThanOrEqual(7)
  })

  it('never counts attach timeouts and restarts after any other outcome or an abort', () => {
    const streak = new RelayHostOfflineStreak(() => null)
    for (const error of [
      attachTimeout(),
      attachTimeout(),
      hostOffline(),
      null,
      hostOffline(),
      new RelayOuterError(4408),
      hostOffline(),
      new RelayDialAbortedError(),
      hostOffline(),
      attachTimeout(),
      hostOffline()
    ]) {
      expect(streak.shouldResolve(error)).toBe(false)
    }
  })

  it('starts a new episode after the phone connected (e.g. direct won) or a long gap', () => {
    let connectedAt: number | null = null
    const streak = new RelayHostOfflineStreak(() => connectedAt)
    streak.shouldResolve(hostOffline())
    vi.advanceTimersByTime(1_000)
    connectedAt = Date.now()
    vi.advanceTimersByTime(1_000)
    expect(streak.shouldResolve(hostOffline())).toBe(false)

    vi.advanceTimersByTime(3 * 60_000)
    expect(streak.shouldResolve(hostOffline())).toBe(false)
  })
})
