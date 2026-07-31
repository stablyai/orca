import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileRelayRpcSession } from './mobile-relay-rpc-session'
import { MobileEndpointSupervisorTimers } from './mobile-endpoint-supervisor-timers'

describe('mobile endpoint supervisor timers', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('replaces a pending retry with the authenticated session lease', async () => {
    const retry = vi.fn()
    const rotate = vi.fn()
    const timers = new MobileEndpointSupervisorTimers(setTimeout, clearTimeout)
    const session = {
      getLeaseExpiresAt: () => 60_000
    } as MobileRelayRpcSession

    timers.scheduleRetry(5_000, retry)
    timers.scheduleLease(session, () => 0, rotate)

    expect(timers.hasScheduled()).toBe(true)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(retry).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(25_000)
    expect(rotate).toHaveBeenCalledOnce()
    expect(timers.hasScheduled()).toBe(false)
  })
})
