import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayRetrySchedule } from './relay-retry-schedule'

afterEach(() => {
  vi.useRealTimers()
})

describe('RelayRetrySchedule', () => {
  it('exposes no settle signal while nothing is armed', () => {
    const schedule = new RelayRetrySchedule(() => 0.5)
    expect(schedule.pending).toBe(false)
    expect(schedule.settled).toBeNull()
  })

  it('settles after the retry has run, so a woken waiter sees its effect', async () => {
    vi.useFakeTimers()
    const schedule = new RelayRetrySchedule(() => 0.5)
    const order: string[] = []
    schedule.schedule(0, () => order.push('retry'))
    const settled = schedule.settled
    expect(settled).not.toBeNull()
    void settled!.then(() => order.push('settled'))

    await vi.advanceTimersByTimeAsync(500)
    expect(order).toEqual(['retry', 'settled'])
    expect(schedule.pending).toBe(false)
    expect(schedule.settled).toBeNull()
  })

  it('settles on cancel without running the retry', async () => {
    vi.useFakeTimers()
    const schedule = new RelayRetrySchedule(() => 0.5)
    const retry = vi.fn()
    schedule.schedule(0, retry)
    const settled = schedule.settled!

    schedule.cancel()
    await expect(settled).resolves.toBeUndefined()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(retry).not.toHaveBeenCalled()
    expect(schedule.settled).toBeNull()
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
