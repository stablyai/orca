import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _resetGhRateLimitBreaker,
  classifyGhRateLimitBucket,
  createGhRateLimitBlockedError,
  getGhRateLimitBlockedUntilMs,
  isGhPrimaryRateLimitStderr,
  isGhRateLimitProbe,
  notifyGhPrimaryRateLimit,
  recordGhPrimaryRateLimit,
  registerGhRateLimitResetProbe
} from './gh-rate-limit-breaker'

afterEach(() => {
  _resetGhRateLimitBreaker()
})

describe('classifyGhRateLimitBucket', () => {
  it('classifies search API endpoints, skipping flag values', () => {
    expect(
      classifyGhRateLimitBucket([
        'api',
        '--cache',
        '120s',
        'search/issues?q=repo:a/b is:issue is:open&per_page=1',
        '--jq',
        '.total_count'
      ])
    ).toBe('search')
    expect(classifyGhRateLimitBucket(['search', 'prs', '--author', 'x'])).toBe('search')
  })

  it('classifies graphql and defaults everything else to core', () => {
    expect(classifyGhRateLimitBucket(['api', 'graphql', '-f', 'query=…'])).toBe('graphql')
    expect(classifyGhRateLimitBucket(['api', 'repos/a/b/pulls?per_page=36'])).toBe('core')
    expect(classifyGhRateLimitBucket(['pr', 'list', '--limit', '36'])).toBe('core')
  })
})

describe('isGhRateLimitProbe', () => {
  it('recognizes the exempt rate_limit endpoint only', () => {
    expect(isGhRateLimitProbe(['api', 'rate_limit'])).toBe(true)
    expect(isGhRateLimitProbe(['api', '/rate_limit'])).toBe(true)
    expect(isGhRateLimitProbe(['api', 'search/issues?q=x'])).toBe(false)
    expect(isGhRateLimitProbe(['pr', 'list'])).toBe(false)
  })
})

describe('isGhPrimaryRateLimitStderr', () => {
  it('matches primary rate-limit 403s but not secondary limits', () => {
    expect(
      isGhPrimaryRateLimitStderr(
        'gh: API rate limit exceeded for user ID 1775218. If you reach out to GitHub Support… (HTTP 403)'
      )
    ).toBe(true)
    expect(isGhPrimaryRateLimitStderr('You have exceeded a secondary rate limit.')).toBe(false)
    expect(isGhPrimaryRateLimitStderr('gh: Not Found (HTTP 404)')).toBe(false)
  })
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

  it('keeps the later of two recorded reset times', () => {
    const now = 1_000_000
    recordGhPrimaryRateLimit('core', now + 60_000)
    recordGhPrimaryRateLimit('core', now + 10_000)
    expect(getGhRateLimitBlockedUntilMs('core', now)).toBe(now + 60_000)
  })

  it('notifyGhPrimaryRateLimit applies a fallback block and fires the reset probe', () => {
    const probe = vi.fn()
    registerGhRateLimitResetProbe(probe)
    notifyGhPrimaryRateLimit('search')
    expect(probe).toHaveBeenCalledWith('search')
    expect(getGhRateLimitBlockedUntilMs('search')).toBeGreaterThan(Date.now())
  })

  it('creates an error that classifies as rate_limited, not permission_denied', () => {
    const error = createGhRateLimitBlockedError('search', Date.now() + 30_000)
    expect(error.stderr.toLowerCase()).toContain('rate limit')
    expect(error.stderr.toLowerCase()).not.toContain('403')
    expect(error.ghRateLimitBlocked).toBe(true)
  })
})
