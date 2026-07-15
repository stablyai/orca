import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const netFetchMock = vi.hoisted(() => vi.fn())
const readCursorAuthSessionMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

vi.mock('./cursor-auth', () => ({
  readCursorAuthSession: readCursorAuthSessionMock
}))

import {
  CURSOR_BUCKET_AUTO,
  CURSOR_BUCKET_INCLUDED,
  CURSOR_BUCKET_ON_DEMAND,
  fetchCursorRateLimits
} from './cursor-fetcher'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response
}

const USAGE_RESPONSE = {
  billingCycleStart: '1783588639000',
  billingCycleEnd: '1786267039000',
  planUsage: {
    totalSpend: 4651,
    includedSpend: 2000,
    limit: 2000,
    autoPercentUsed: 31,
    apiPercentUsed: 0,
    totalPercentUsed: 23.85
  },
  spendLimitUsage: {
    individualLimit: 1000,
    individualRemaining: 750,
    limitType: 'user'
  },
  displayMessage: "You've used 67% of your included usage",
  autoModelSelectedDisplayMessage: "You've used 24% of your included total usage",
  namedModelSelectedDisplayMessage: "You've used 0% of your included API usage"
}

function signedInAuth() {
  return {
    status: 'ok' as const,
    session: {
      accessToken: 'access-token',
      refreshToken: null,
      email: 'dev@example.com',
      membershipType: 'pro'
    }
  }
}

describe('fetchCursorRateLimits', () => {
  beforeEach(() => {
    netFetchMock.mockReset()
    readCursorAuthSessionMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns unavailable when not signed in', async () => {
    readCursorAuthSessionMock.mockReturnValue({ status: 'missing' })
    const result = await fetchCursorRateLimits()
    expect(result.provider).toBe('cursor')
    expect(result.status).toBe('unavailable')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('maps Included, Auto, and On-demand buckets from period usage', async () => {
    readCursorAuthSessionMock.mockReturnValue(signedInAuth())
    netFetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    const result = await fetchCursorRateLimits()
    expect(result.status).toBe('ok')
    expect(result.weekly).toBeNull()
    expect(result.session).toBeNull()
    expect(result.buckets).toEqual([
      expect.objectContaining({
        name: CURSOR_BUCKET_INCLUDED,
        usedPercent: 23.85,
        windowMinutes: 44_640,
        resetsAt: 1_786_267_039_000
      }),
      expect.objectContaining({
        name: CURSOR_BUCKET_AUTO,
        usedPercent: 31,
        windowMinutes: 44_640
      }),
      expect.objectContaining({
        name: CURSOR_BUCKET_ON_DEMAND,
        usedPercent: 25,
        windowMinutes: 44_640
      })
    ])
    expect(result.usageMetadata).toEqual({
      source: 'oauth',
      authProvenance: 'dev@example.com (pro)'
    })
  })

  it('prefers totalPercentUsed over displayMessage for Included', async () => {
    readCursorAuthSessionMock.mockReturnValue(signedInAuth())
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        planUsage: { totalPercentUsed: 29, autoPercentUsed: 37, apiPercentUsed: 0 },
        displayMessage: "You've used 67% of your included usage"
      })
    )

    const result = await fetchCursorRateLimits()
    expect(result.buckets?.[0]).toEqual(
      expect.objectContaining({ name: CURSOR_BUCKET_INCLUDED, usedPercent: 29 })
    )
  })

  it('ignores displayMessage when it is the only Included signal', async () => {
    readCursorAuthSessionMock.mockReturnValue(signedInAuth())
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        planUsage: { autoPercentUsed: 10, apiPercentUsed: 3 },
        displayMessage: "You've used 67% of your included usage"
      })
    )

    const result = await fetchCursorRateLimits()
    expect(result.buckets).toEqual([
      expect.objectContaining({ name: CURSOR_BUCKET_AUTO, usedPercent: 10 })
    ])
  })

  it('does not treat apiPercentUsed as On-demand', async () => {
    readCursorAuthSessionMock.mockReturnValue(signedInAuth())
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        planUsage: { totalPercentUsed: 20, autoPercentUsed: 15, apiPercentUsed: 90 }
      })
    )

    const result = await fetchCursorRateLimits()
    expect(result.buckets?.some((bucket) => bucket.name === CURSOR_BUCKET_ON_DEMAND)).toBe(false)
    expect(result.buckets).toEqual([
      expect.objectContaining({ name: CURSOR_BUCKET_INCLUDED, usedPercent: 20 }),
      expect.objectContaining({ name: CURSOR_BUCKET_AUTO, usedPercent: 15 })
    ])
  })

  it('falls back to includedSpend/limit for Included when totalPercentUsed is absent', async () => {
    readCursorAuthSessionMock.mockReturnValue({
      status: 'ok',
      session: {
        accessToken: 'access-token',
        refreshToken: null,
        email: null,
        membershipType: null
      }
    })
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        billingCycleStart: 1_000_000,
        billingCycleEnd: 1_000_000 + 30 * 24 * 60 * 60 * 1000,
        planUsage: { includedSpend: 500, limit: 2000, autoPercentUsed: 10 }
      })
    )

    const result = await fetchCursorRateLimits()
    expect(result.status).toBe('ok')
    expect(result.buckets?.[0]).toEqual(
      expect.objectContaining({ name: CURSOR_BUCKET_INCLUDED, usedPercent: 25 })
    )
    expect(result.buckets?.[1]).toEqual(
      expect.objectContaining({ name: CURSOR_BUCKET_AUTO, usedPercent: 10 })
    )
    expect(result.usageMetadata?.authProvenance).toBe('Cursor account')
  })

  it('omits On-demand when spendLimitUsage is absent', async () => {
    readCursorAuthSessionMock.mockReturnValue(signedInAuth())
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        planUsage: { totalPercentUsed: 12.5, autoPercentUsed: 8, apiPercentUsed: 3 }
      })
    )

    const result = await fetchCursorRateLimits()
    expect(result.buckets).toEqual([
      expect.objectContaining({ name: CURSOR_BUCKET_INCLUDED, usedPercent: 12.5 }),
      expect.objectContaining({ name: CURSOR_BUCKET_AUTO, usedPercent: 8 })
    ])
  })

  it('prefers individualUsed over remaining for On-demand', async () => {
    readCursorAuthSessionMock.mockReturnValue(signedInAuth())
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        planUsage: { totalPercentUsed: 10, autoPercentUsed: 5 },
        spendLimitUsage: {
          individualLimit: 1000,
          individualUsed: 250,
          individualRemaining: 800
        }
      })
    )

    const result = await fetchCursorRateLimits()
    expect(result.buckets?.[2]).toEqual(
      expect.objectContaining({ name: CURSOR_BUCKET_ON_DEMAND, usedPercent: 25 })
    )
  })

  it('returns expired-session error on HTTP 401', async () => {
    readCursorAuthSessionMock.mockReturnValue({
      status: 'ok',
      session: {
        accessToken: 'stale',
        refreshToken: null,
        email: null,
        membershipType: null
      }
    })
    netFetchMock.mockResolvedValueOnce(jsonResponse({}, 401))

    const result = await fetchCursorRateLimits()
    expect(result.status).toBe('error')
    expect(result.error).toContain('sign in again in Cursor')
  })

  it('returns unavailable when usage payload has no percent signals', async () => {
    readCursorAuthSessionMock.mockReturnValue(signedInAuth())
    netFetchMock.mockResolvedValueOnce(jsonResponse({ enabled: true }))

    const result = await fetchCursorRateLimits()
    expect(result.status).toBe('unavailable')
    expect(result.buckets).toEqual([])
  })
})
