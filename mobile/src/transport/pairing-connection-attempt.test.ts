import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PAIR_CONNECT_TIMEOUT_MS,
  PAIR_MAX_DIAL_ENDPOINTS,
  PAIRING_OVERALL_TIMEOUT_MS,
  resolvePairDialPlan,
  startPairingConnectionAttempt
} from './pairing-connection-attempt'

describe('pairing connection attempt cleanup', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('closes the temporary client when the overall pairing timeout fires', () => {
    vi.useFakeTimers()
    const closeClient = vi.fn()

    const attempt = startPairingConnectionAttempt({ timeoutMs: 25_000, closeClient })

    expect(attempt.timedOut).toBe(false)
    vi.advanceTimersByTime(24_999)
    expect(closeClient).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(attempt.timedOut).toBe(true)
    expect(closeClient).toHaveBeenCalledTimes(1)

    attempt.dispose()
    expect(closeClient).toHaveBeenCalledTimes(1)
  })

  it('clears the timeout and closes the temporary client when disposed early', () => {
    vi.useFakeTimers()
    const closeClient = vi.fn()

    const attempt = startPairingConnectionAttempt({ timeoutMs: 25_000, closeClient })
    attempt.dispose()

    expect(attempt.timedOut).toBe(false)
    expect(closeClient).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(25_000)
    expect(attempt.timedOut).toBe(false)
    expect(closeClient).toHaveBeenCalledTimes(1)
  })
})

describe('resolvePairDialPlan (KTD4)', () => {
  it('uses a shorter per-endpoint timeout than steady-state 12s', () => {
    const plan = resolvePairDialPlan(['ws://100.1.1.1:6768', 'ws://192.168.1.10:6768'])
    expect(plan.connectTimeoutMs).toBe(PAIR_CONNECT_TIMEOUT_MS)
    expect(plan.connectTimeoutMs).toBeLessThan(12_000)
    expect(plan.endpoints).toHaveLength(2)
  })

  it('caps pair-time exploration at three endpoints', () => {
    const endpoints = [
      'ws://100.1.1.1:6768',
      'ws://192.168.1.10:6768',
      'ws://10.0.0.5:6768',
      'ws://10.0.0.6:6768'
    ]
    const plan = resolvePairDialPlan(endpoints)
    expect(plan.endpoints).toHaveLength(PAIR_MAX_DIAL_ENDPOINTS)
    expect(plan.endpoints).toEqual(endpoints.slice(0, PAIR_MAX_DIAL_ENDPOINTS))
  })

  it('keeps n×timeout + margin within the overall pair budget', () => {
    const plan = resolvePairDialPlan([
      'ws://100.1.1.1:6768',
      'ws://192.168.1.10:6768',
      'ws://10.0.0.5:6768'
    ])
    const dialBudget = plan.endpoints.length * plan.connectTimeoutMs
    expect(dialBudget + 7_000).toBeLessThanOrEqual(PAIRING_OVERALL_TIMEOUT_MS)
  })
})
