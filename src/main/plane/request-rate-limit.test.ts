import { beforeEach, describe, expect, it } from 'vitest'
import {
  getThrottleWaitMs,
  noteRateLimited,
  noteRateLimitHeaders,
  rateLimitBudgetKey,
  resetRateLimitState
} from './request-rate-limit'

const NOW = 1_800_000_000_000

function headers(values: Record<string, string>): { get(name: string): string | null } {
  return { get: (name) => values[name.toLowerCase()] ?? null }
}

beforeEach(() => {
  resetRateLimitState()
})

describe('noteRateLimitHeaders', () => {
  it('does not park a workspace while budget remains', () => {
    noteRateLimitHeaders('ws-1', headers({ 'x-ratelimit-remaining': '7' }), NOW)
    expect(getThrottleWaitMs('ws-1', NOW)).toBe(0)
  })

  it('parks until the advertised unix reset once the budget is spent', () => {
    const resetSeconds = Math.floor(NOW / 1000) + 30
    noteRateLimitHeaders(
      'ws-1',
      headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSeconds) }),
      NOW
    )
    expect(getThrottleWaitMs('ws-1', NOW)).toBe(30_000)
  })

  it('accepts a relative reset value and falls back to a full window', () => {
    noteRateLimitHeaders(
      'ws-1',
      headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '15' }),
      NOW
    )
    expect(getThrottleWaitMs('ws-1', NOW)).toBe(15_000)

    resetRateLimitState()
    noteRateLimitHeaders('ws-1', headers({ 'x-ratelimit-remaining': '0' }), NOW)
    expect(getThrottleWaitMs('ws-1', NOW)).toBe(60_000)
  })

  it('shares one budget across workspaces using the same api token', () => {
    // Plane's allowance is per API key. Keying by workspace let one token
    // connected to two workspaces spend the allowance twice and earn 429s for
    // both, so the key is a digest of the token.
    const shared = rateLimitBudgetKey('plane_api_shared')
    const other = rateLimitBudgetKey('plane_api_other')
    noteRateLimitHeaders(shared, headers({ 'x-ratelimit-remaining': '0' }), NOW)
    expect(getThrottleWaitMs(shared, NOW)).toBe(60_000)
    expect(getThrottleWaitMs(other, NOW)).toBe(0)
  })

  it('derives a stable key that never contains the raw token', () => {
    const key = rateLimitBudgetKey('plane_api_secret')
    expect(key).toBe(rateLimitBudgetKey('plane_api_secret'))
    expect(key).not.toContain('plane_api_secret')
    expect(key).not.toBe(rateLimitBudgetKey('plane_api_other'))
  })

  it('expires the park once the window passes', () => {
    noteRateLimitHeaders('ws-1', headers({ 'x-ratelimit-remaining': '0' }), NOW)
    expect(getThrottleWaitMs('ws-1', NOW + 60_001)).toBe(0)
  })
})

describe('noteRateLimited', () => {
  it('prefers Retry-After and returns the wait it applied', () => {
    expect(noteRateLimited('ws-1', headers({ 'retry-after': '5' }), NOW)).toBe(5_000)
  })

  it('is authoritative even with no budget headers', () => {
    noteRateLimited('ws-1', headers({}), NOW)
    expect(getThrottleWaitMs('ws-1', NOW)).toBe(60_000)
  })

  it('never shortens an existing park', () => {
    noteRateLimited('ws-1', headers({ 'retry-after': '30' }), NOW)
    noteRateLimited('ws-1', headers({ 'retry-after': '1' }), NOW)
    expect(getThrottleWaitMs('ws-1', NOW)).toBe(30_000)
  })

  it('caps the reported wait so a bad header cannot stall a caller', () => {
    expect(noteRateLimited('ws-1', headers({ 'retry-after': '9999' }), NOW)).toBe(60_000)
  })
})

describe('deployments that advertise no budget', () => {
  it('never parks a workspace when the headers are absent entirely', () => {
    // Regression: Number(null) is 0, so a naive finite check read "no header"
    // as "budget exhausted" and throttled every self-hosted response.
    noteRateLimitHeaders('ws-1', headers({}), NOW)
    expect(getThrottleWaitMs('ws-1', NOW)).toBe(0)
  })

  it('ignores a blank or non-numeric budget header', () => {
    noteRateLimitHeaders('ws-1', headers({ 'x-ratelimit-remaining': '   ' }), NOW)
    noteRateLimitHeaders('ws-2', headers({ 'x-ratelimit-remaining': 'many' }), NOW)
    expect(getThrottleWaitMs('ws-1', NOW)).toBe(0)
    expect(getThrottleWaitMs('ws-2', NOW)).toBe(0)
  })
})
