import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayRetrySchedule } from './relay-retry-schedule'

afterEach(() => {
  vi.useRealTimers()
})

describe('RelayRetrySchedule', () => {
  it('clears the timer on cancel without running the retry', async () => {
    vi.useFakeTimers()
    const schedule = new RelayRetrySchedule(() => 0.5)
    const retry = vi.fn()
    schedule.schedule(0, retry)
    expect(schedule.pending).toBe(true)

    schedule.cancel()
    expect(schedule.pending).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(retry).not.toHaveBeenCalled()
  })

  it('keeps the attempt count across cancel so a superseded retry does not restart the ladder', async () => {
    vi.useFakeTimers()
    const schedule = new RelayRetrySchedule(() => 0.5)
    schedule.schedule(0, () => {})
    schedule.cancel()
    const retry = vi.fn()
    schedule.schedule(0, retry)
    await vi.advanceTimersByTimeAsync(999)
    expect(retry).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(retry).toHaveBeenCalledOnce()
  })

  it('waits out a server Retry-After that outlasts the jitter band', async () => {
    vi.useFakeTimers()
    const schedule = new RelayRetrySchedule(() => 0.5)
    const retry = vi.fn()
    schedule.schedule(30_000, retry)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(retry).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(retry).toHaveBeenCalledOnce()
  })
})
