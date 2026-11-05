import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installIllegalInvocationTimerGuards } from './global-timer-receiver-test-fakes'
import {
  LIVENESS_IDLE_MS,
  LIVENESS_PROBE_TIMEOUT_MS,
  RpcSessionLivenessWatchdog
} from './rpc-session-liveness-watchdog'

describe('RpcSessionLivenessWatchdog default timers', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('schedules and clears with no injected timers when the global rejects a non-global receiver', async () => {
    const timers = installIllegalInvocationTimerGuards()
    const sendProbe = vi.fn(() => true)
    const terminate = vi.fn()
    const watchdog = new RpcSessionLivenessWatchdog({ transport: 'direct', sendProbe, terminate })
    const identity = {}

    watchdog.start(identity)
    await vi.advanceTimersByTimeAsync(LIVENESS_IDLE_MS)
    expect(sendProbe).toHaveBeenCalledOnce()

    watchdog.stop(identity)
    expect(timers.cleared).toHaveLength(1)
    expect(timers.cleared[0]).toBe(timers.scheduled[1])
    await vi.advanceTimersByTimeAsync(LIVENESS_PROBE_TIMEOUT_MS)
    expect(terminate).not.toHaveBeenCalled()
  })
})
