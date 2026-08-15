import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostOpenRetryScheduler } from './host-open-retry-scheduler'

describe('HostOpenRetryScheduler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('advances through bounded retry tiers', async () => {
    let generation = 1
    const open = vi.fn()
    const scheduler = new HostOpenRetryScheduler({
      canRetry: (_hostId, candidate) => candidate === generation,
      open
    })

    scheduler.recordFailure('host-1', generation)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(open).toHaveBeenCalledOnce()

    generation = 2
    scheduler.recordFailure('host-1', generation)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(open).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('expedites without forgiving the failure streak', async () => {
    let generation = 1
    const open = vi.fn()
    const scheduler = new HostOpenRetryScheduler({
      canRetry: (_hostId, candidate) => candidate === generation,
      open
    })

    scheduler.recordFailure('host-1', generation)
    scheduler.expedite('host-1')
    expect(open).toHaveBeenCalledOnce()

    generation = 2
    scheduler.recordFailure('host-1', generation)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(open).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('cancels retry delivery', async () => {
    const open = vi.fn()
    const scheduler = new HostOpenRetryScheduler({ canRetry: () => true, open })
    scheduler.recordFailure('host-1', 1)
    scheduler.cancel('host-1')

    await vi.advanceTimersByTimeAsync(60_000)
    expect(open).not.toHaveBeenCalled()
  })
})
