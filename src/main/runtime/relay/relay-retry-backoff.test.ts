import { describe, expect, it } from 'vitest'
import { computeRetryDelayMs } from './relay-retry-backoff'

describe('computeRetryDelayMs', () => {
  it('grows the jitter ceiling with the attempt count, capped at the retry max', () => {
    expect(computeRetryDelayMs(0, 0, () => 0.5)).toBe(500)
    expect(computeRetryDelayMs(1, 0, () => 0.5)).toBe(1_000)
    // Attempt 9 already saturates the doubling (1_000 * 2^9 > 5 minutes), so a
    // further attempt must not keep growing the ceiling past the retry max.
    expect(computeRetryDelayMs(9, 0, () => 0.5)).toBe(150_000)
    expect(computeRetryDelayMs(20, 0, () => 0.5)).toBe(150_000)
  })

  it('never exceeds the retry max even at the top of the jitter band', () => {
    expect(computeRetryDelayMs(20, 0, () => 1)).toBeLessThanOrEqual(5 * 60_000 + 1)
  })

  it('honours a server Retry-After that outlasts the jitter band', () => {
    expect(computeRetryDelayMs(0, 30_000, () => 0.5)).toBe(30_000)
    expect(computeRetryDelayMs(0, 200, () => 0.5)).toBe(500)
  })
})
