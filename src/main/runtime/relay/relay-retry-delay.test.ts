import { describe, expect, it } from 'vitest'
import { relayRetryDelayMs } from './relay-retry-delay'

describe('relayRetryDelayMs', () => {
  it('grows the jitter ceiling with the attempt count, capped at the retry max', () => {
    expect(relayRetryDelayMs(0, () => 0.5)).toBe(500)
    expect(relayRetryDelayMs(1, () => 0.5)).toBe(1_000)
    // Attempt 9 already saturates the doubling (1_000 * 2^9 > 5 minutes), so a
    // further attempt must not keep growing the ceiling past the retry max.
    expect(relayRetryDelayMs(9, () => 0.5)).toBe(150_000)
    expect(relayRetryDelayMs(20, () => 0.5)).toBe(150_000)
  })

  it('never exceeds the retry max even at the top of the jitter band', () => {
    expect(relayRetryDelayMs(20, () => 1)).toBeLessThanOrEqual(5 * 60_000 + 1)
  })
})
