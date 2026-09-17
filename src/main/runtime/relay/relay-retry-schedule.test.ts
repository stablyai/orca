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

  // Why this matters beyond the throw itself: the retry callback is the caller's whole recovery
  // step (the origin pool's `handleDrain` reaches `onStatus` -> `webContents.send`). A throw used
  // to escape the timer AND skip the resolve, parking every `settled` waiter on a promise nothing
  // would settle while the schedule held no armed timer — dead with no re-entry.
  it('settles and stays reschedulable when the retry throws', async () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const schedule = new RelayRetrySchedule(() => 0.5)
    schedule.schedule(0, () => {
      throw new Error('recovery step blew up')
    })
    const settled = schedule.settled!

    await vi.advanceTimersByTimeAsync(500)

    await expect(settled).resolves.toBeUndefined()
    expect(schedule.pending).toBe(false)
    expect(consoleError).toHaveBeenCalled()

    const next = vi.fn()
    schedule.schedule(0, next)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(next).toHaveBeenCalledTimes(1)
    consoleError.mockRestore()
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
