import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CursorAuthReadResult } from './cursor-auth'
import {
  CURSOR_GROK_BOT_BUCKET,
  CURSOR_MODELS_BUCKET,
  CURSOR_OTHER_BUCKET,
  fetchCursorRateLimits,
  mapCursorSandUsage,
  mapCursorUsageSummary
} from './cursor-fetcher'

const netFetchMock = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ net: { fetch: netFetchMock } }))

function mintJwt(sub: string): string {
  return `head.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.sig`
}

function jsonResponse(body: unknown, status = 200): Response {
  return { status, json: async () => body } as Response
}

const signedIn: CursorAuthReadResult = {
  status: 'ok',
  session: {
    accessToken: mintJwt('auth0|user-1'),
    subject: 'auth0|user-1',
    source: 'desktop',
    email: 'dev@example.com',
    membershipType: 'ultra',
    subscriptionStatus: 'active'
  }
}

const SUMMARY = {
  billingCycleStart: '2026-07-27T20:01:49.000Z',
  billingCycleEnd: '2026-08-27T20:01:49.000Z',
  membershipType: 'ultra',
  individualUsage: {
    plan: { autoPercentUsed: 100, apiPercentUsed: 41.5 },
    onDemand: { enabled: false, used: 0, limit: null }
  }
}

const SAND = {
  currentPeriodStart: '2026-08-26T17:22:03.913Z',
  nextResetTimestampUtc: '2026-08-31T15:44:42.913Z',
  usagePercent: 12,
  hasNonZeroIncludedLimit: true
}

describe('Cursor response mapping', () => {
  it('maps present billing pools without inventing a missing pool', () => {
    const mapped = mapCursorUsageSummary(SUMMARY)
    expect(mapped.buckets.map((bucket) => bucket.name)).toEqual([
      CURSOR_MODELS_BUCKET,
      CURSOR_OTHER_BUCKET
    ])
    expect(mapped.buckets.map((bucket) => bucket.usedPercent)).toEqual([100, 41.5])
    expect(mapped.buckets[0]).toMatchObject({
      resetsAt: Date.parse(SUMMARY.billingCycleEnd),
      resetDescription: null
    })
    const withoutBounds = mapCursorUsageSummary({
      individualUsage: { plan: { autoPercentUsed: 12 } }
    }).buckets
    expect(withoutBounds).toHaveLength(1)
    expect(withoutBounds[0]).not.toHaveProperty('windowMinutes')
  })

  it('maps the Grok Bot pool and omits accounts without an included limit', () => {
    expect(mapCursorSandUsage(SAND)?.name).toBe(CURSOR_GROK_BOT_BUCKET)
    expect(mapCursorSandUsage(SAND)).toMatchObject({
      resetsAt: Date.parse(SAND.nextResetTimestampUtc),
      resetDescription: null
    })
    expect(mapCursorSandUsage({ ...SAND, hasNonZeroIncludedLimit: false })).toBeNull()
  })
})

describe('fetchCursorRateLimits', () => {
  beforeEach(() => netFetchMock.mockReset())

  it('returns unavailable without making a request when signed out', async () => {
    const result = await fetchCursorRateLimits({ authReadResult: { status: 'missing' } })
    expect(result).toMatchObject({
      provider: 'cursor',
      status: 'unavailable',
      session: null,
      weekly: null
    })
    expect(result.monthly).toBeUndefined()
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('returns an auth read failure instead of signed-out guidance', async () => {
    const result = await fetchCursorRateLimits({
      authReadResult: { status: 'error', error: 'Unable to read Cursor desktop auth' }
    })

    expect(result).toMatchObject({
      status: 'error',
      error: 'Unable to read Cursor desktop auth'
    })
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('returns all named pools and account identity', async () => {
    netFetchMock
      .mockResolvedValueOnce(jsonResponse(SUMMARY))
      .mockResolvedValueOnce(jsonResponse(SAND))
    const result = await fetchCursorRateLimits({ authReadResult: signedIn })
    expect(result.status).toBe('ok')
    expect(result.buckets?.map((bucket) => bucket.name)).toEqual([
      CURSOR_MODELS_BUCKET,
      CURSOR_OTHER_BUCKET,
      CURSOR_GROK_BOT_BUCKET
    ])
    expect(result.usageMetadata).toMatchObject({
      accountEmail: 'dev@example.com',
      subscriptionStatus: 'active'
    })
    expect(result.usageMetadata?.authProvenance).toBe('dev@example.com · ultra · active')
  })

  it('keeps billing pools when the optional Grok Bot RPC fails', async () => {
    netFetchMock
      .mockResolvedValueOnce(jsonResponse(SUMMARY))
      .mockRejectedValueOnce(new Error('sand down'))
    const result = await fetchCursorRateLimits({ authReadResult: signedIn })
    expect(result.status).toBe('ok')
    expect(result.buckets?.map((bucket) => bucket.name)).toEqual([
      CURSOR_MODELS_BUCKET,
      CURSOR_OTHER_BUCKET
    ])
  })

  it('does not fake 0% when no usage pool is present', async () => {
    netFetchMock
      .mockResolvedValueOnce(jsonResponse({ individualUsage: {} }))
      .mockResolvedValueOnce(jsonResponse({}))
    const result = await fetchCursorRateLimits({ authReadResult: signedIn })
    expect(result.status).toBe('unavailable')
    expect(result.buckets).toBeUndefined()
  })

  it('maps unauthorized responses to sign-in state without exposing the token', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse({}, 401))
    const result = await fetchCursorRateLimits({ authReadResult: signedIn })
    expect(result.usageMetadata?.failureKind).toBe('delegated-refresh-required')
    expect(JSON.stringify(result)).not.toContain(signedIn.session.accessToken)
  })

  it('sanitizes transport failures before returning state', async () => {
    netFetchMock.mockRejectedValueOnce(
      new Error('/home/alice/.cursor/auth.json failed with secret-token')
    )

    const result = await fetchCursorRateLimits({ authReadResult: signedIn })

    expect(result).toMatchObject({ status: 'error', error: 'Cursor usage request failed' })
    expect(JSON.stringify(result)).not.toContain('/home/alice')
    expect(JSON.stringify(result)).not.toContain('secret-token')
  })
})
