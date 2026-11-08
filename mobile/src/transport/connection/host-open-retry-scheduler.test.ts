import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HostOpenRetryScheduler } from './host-open-retry-scheduler'

describe('HostOpenRetryScheduler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
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
