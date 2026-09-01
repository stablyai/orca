import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPollingFallbackRetry } from './worktree-git-common-narrow-watch-fallback-retry'

describe('git-common narrow-watch polling fallback retry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('backs off geometrically between attempts, capped at 15 minutes', async () => {
    const attempts: number[] = []
    let now = 0
    const tryRecover = vi.fn(async () => {
      attempts.push(now)
      return false
    })
    const retry = createPollingFallbackRetry(tryRecover)

    retry.scheduleNext()
    const advance = async (ms: number): Promise<void> => {
      now += ms
      await vi.advanceTimersByTimeAsync(ms)
    }
    // Delays double each failed attempt (30s, 1m, 2m, 4m, 8m) until the 6th
    // would exceed 15m and gets capped there instead of reaching 16m.
    await advance(30_000)
    await advance(60_000)
    await advance(120_000)
    await advance(240_000)
    await advance(480_000)
    await advance(15 * 60_000)

    expect(attempts).toEqual([30_000, 90_000, 210_000, 450_000, 930_000, 1_830_000])
    expect(tryRecover).toHaveBeenCalledTimes(6)
  })

  it('does not schedule a second timer while one is already pending', async () => {
    const tryRecover = vi.fn(async () => false)
    const retry = createPollingFallbackRetry(tryRecover)

    retry.scheduleNext()
    retry.scheduleNext()
    retry.scheduleNext()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(tryRecover).toHaveBeenCalledTimes(1)
  })

  it('stops retrying once recovery succeeds', async () => {
    const tryRecover = vi.fn(async () => true)
    const retry = createPollingFallbackRetry(tryRecover)

    retry.scheduleNext()
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    expect(tryRecover).toHaveBeenCalledTimes(1)
  })

  it('cancel resets the backoff so the next cycle restarts at the base delay', async () => {
    const tryRecover = vi.fn(async () => false)
    const retry = createPollingFallbackRetry(tryRecover)

    retry.scheduleNext()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(tryRecover).toHaveBeenCalledTimes(1)
    retry.cancel()

    retry.scheduleNext()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(tryRecover).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(tryRecover).toHaveBeenCalledTimes(2)
  })

  it('cancel before the timer fires prevents that attempt entirely', async () => {
    const tryRecover = vi.fn(async () => false)
    const retry = createPollingFallbackRetry(tryRecover)

    retry.scheduleNext()
    retry.cancel()
    await vi.advanceTimersByTimeAsync(60 * 60_000)

    expect(tryRecover).not.toHaveBeenCalled()
  })
})
