import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetGhRateLimitBreaker,
  getGhRateLimitBlockedUntilMs,
  recordGhPrimaryRateLimit
} from './gh-rate-limit-breaker'

afterEach(() => {
  _resetGhRateLimitBreaker()
})

describe('breaker state', () => {
  it('blocks until the recorded time, then expires', () => {
    const now = 1_000_000
    recordGhPrimaryRateLimit('search', now + 5_000)
    expect(getGhRateLimitBlockedUntilMs('search', now)).toBe(now + 5_000)
    expect(getGhRateLimitBlockedUntilMs('core', now)).toBeNull()
    expect(getGhRateLimitBlockedUntilMs('search', now + 5_001)).toBeNull()
    // Expiry is sticky — the entry was removed on the expired read.
    expect(getGhRateLimitBlockedUntilMs('search', now)).toBeNull()
  })

  it('isolates blocks by host and execution runtime scope', () => {
    const now = 1_000_000
    recordGhPrimaryRateLimit('core', now + 60_000, 'native:github.com')

    expect(getGhRateLimitBlockedUntilMs('core', now, 'native:github.com')).toBe(now + 60_000)
    expect(getGhRateLimitBlockedUntilMs('core', now, 'native:github.acme-corp.com')).toBeNull()
    expect(getGhRateLimitBlockedUntilMs('core', now, 'wsl:ubuntu:github.com')).toBeNull()
  })
})
