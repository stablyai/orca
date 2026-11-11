import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _resetGhRateLimitBreaker,
  getGhRateLimitBlockedUntilMs,
  notifyGhPrimaryRateLimit,
  recordGhPrimaryRateLimit,
  registerGhRateLimitResetProbe
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

  it('fires the reset probe with the tripping scope for non-default scopes', () => {
    // Reset probes need the blocked host/runtime, including GHES and WSL-only installs.
    const probe = vi.fn()
    registerGhRateLimitResetProbe(probe)

    notifyGhPrimaryRateLimit('core', 'native:github.acme-corp.com')
    notifyGhPrimaryRateLimit('core', 'wsl:ubuntu:github.com')

    expect(probe).toHaveBeenNthCalledWith(1, 'core', 'native:github.acme-corp.com')
    expect(probe).toHaveBeenNthCalledWith(2, 'core', 'wsl:ubuntu:github.com')
    expect(
      getGhRateLimitBlockedUntilMs('core', Date.now(), 'native:github.acme-corp.com')
    ).not.toBeNull()
  })
})
