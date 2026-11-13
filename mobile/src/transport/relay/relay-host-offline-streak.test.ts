import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayHostOfflineStreak } from './relay-host-offline-streak'
import { RelayDialAbortedError } from './mobile-relay-director-fallback'
import { RelayOuterError } from '../encryption/mobile-relay-e2ee-link'

const hostOffline = () => new RelayOuterError(4404)
const attachTimeout = () => new RelayOuterError(4404, false, 'attach-timeout')

describe('RelayHostOfflineStreak', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  // 4404 retries are paced 5-15s; use 10s. Returns the minute of each resolve.
  function resolveMinutesOver(ms: number, streak: RelayHostOfflineStreak): number[] {
    const startedAt = Date.now()
    const minutes: number[] = []
    for (let elapsed = 0; elapsed < ms; elapsed += 10_000) {
      if (streak.shouldResolve(hostOffline())) {
        minutes.push(Math.round((Date.now() - startedAt) / 60_000))
      }
      vi.advanceTimersByTime(10_000)
    }
    return minutes
  }

  it('resolves on the second 4404, then at doubling gaps for a desktop that stays offline', () => {
    const streak = new RelayHostOfflineStreak(() => null)
    // Gaps of 5, 10, 20, 40 and then 60 minutes.
    expect(resolveMinutesOver(3 * 60 * 60_000, streak)).toEqual([0, 5, 15, 35, 75, 135])
  })

  it('returns to the 5-minute gap after a successful relay dial', () => {
    const streak = new RelayHostOfflineStreak(() => null)
    expect(resolveMinutesOver(40 * 60_000, streak)).toEqual([0, 5, 15, 35])
    expect(streak.shouldResolve(null)).toBe(false)
    expect(resolveMinutesOver(6 * 60_000, streak)).toEqual([0, 5])
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
