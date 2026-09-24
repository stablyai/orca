import { beforeEach, describe, expect, it, vi } from 'vitest'

const netFetchMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({ net: { fetch: netFetchMock } }))

import { fetchCursorRateLimits } from './cursor-fetcher'
import type { CursorAuthReadResult } from './cursor-auth'
import { parseCursorSessionToken } from './cursor-session-token'

type JwtSegment = Record<string, unknown>

function jwt(exp: number): string {
  const encode = (value: JwtSegment): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'RS256' })}.${encode({ sub: 'auth0|user_1', exp })}.signature`
}

function session(expSeconds = 4_000_000_000): CursorAuthReadResult {
  return {
    status: 'ok',
    session: {
      token: parseCursorSessionToken(jwt(expSeconds))!,
      source: 'keychain',
      email: 'dev@example.com',
      displayName: 'Dev',
      membershipType: null,
      subscriptionStatus: null
    }
  }
}

type FakeResponse = Pick<Response, 'ok' | 'status'> & {
  headers: Pick<Headers, 'get'>
  json: () => Promise<unknown>
}

function fakeResponse(response: FakeResponse): Response {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fetcher only reads ok/status/headers.get/json, all of which FakeResponse provides.
  return response as unknown as Response
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return fakeResponse({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body
  })
}

const SUMMARY = {
  billingCycleStart: '2026-09-01T00:00:00.000Z',
  billingCycleEnd: '2026-10-01T00:00:00.000Z',
  membershipType: 'pro',
  individualUsage: {
    plan: { enabled: true, used: 2_500, limit: 5_000, autoPercentUsed: 40, apiPercentUsed: 12 }
  }
}

beforeEach(() => {
  netFetchMock.mockReset()
})

describe('fetchCursorRateLimits', () => {
  it('publishes both plan pools and the cycle reset', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse(SUMMARY))
    const limits = await fetchCursorRateLimits({ authReadResult: session() })
    expect(limits.status).toBe('ok')
    expect(limits.monthly?.usedPercent).toBe(50)
    expect(limits.buckets?.map((bucket) => bucket.name)).toEqual(['Cursor Models', 'Other Models'])
    expect(limits.planType).toBe('pro')
    expect(limits.usageMetadata).toMatchObject({ source: 'cli', credentialSource: 'keychain' })
  })

  it('sends the origin headers the dashboard checks as CSRF defence', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse(SUMMARY))
    await fetchCursorRateLimits({ authReadResult: session() })
    const [url, init] = netFetchMock.mock.calls[0] ?? []
    expect(url).toBe('https://cursor.com/api/usage-summary')
    expect(init?.headers).toMatchObject({
      Origin: 'https://cursor.com',
      Referer: 'https://cursor.com/dashboard',
      Cookie: expect.stringContaining('WorkosCursorSessionToken=auth0%7Cuser_1%3A%3A')
    })
  })

  it('reports an expired session without spending a request that must 401', async () => {
    const limits = await fetchCursorRateLimits({ authReadResult: session(1_000) })
    expect(netFetchMock).not.toHaveBeenCalled()
    expect(limits.status).toBe('error')
    expect(limits.usageMetadata?.failureKind).toBe('stale-token')
    expect(limits.error).toContain('cursor-agent login')
  })

  it('tells a signed-out user how to sign in, without painting an error bar', async () => {
    const limits = await fetchCursorRateLimits({ authReadResult: { status: 'missing' } })
    expect(limits.status).toBe('unavailable')
    expect(limits.usageMetadata?.failureKind).toBe('missing-credentials')
  })

  it('surfaces a credential read failure', async () => {
    const limits = await fetchCursorRateLimits({
      authReadResult: { status: 'error', error: 'Unable to read the Cursor CLI auth file' }
    })
    expect(limits.status).toBe('error')
    expect(limits.error).toBe('Unable to read the Cursor CLI auth file')
  })

  it('treats a rejected session as expired sign-in and records Retry-After on 429', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse({}, 401))
    expect(
      (await fetchCursorRateLimits({ authReadResult: session() })).usageMetadata?.failureKind
    ).toBe('stale-token')

    netFetchMock.mockResolvedValueOnce(jsonResponse({}, 429, { 'retry-after': '60' }))
    const limited = await fetchCursorRateLimits({ authReadResult: session() })
    expect(limited.usageMetadata?.failureKind).toBe('rate-limited')
    expect(limited.usageMetadata?.retryAtMs).toBeGreaterThan(Date.now())
  })

  it('reports a server failure with its status code', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse({}, 503))
    const limits = await fetchCursorRateLimits({ authReadResult: session() })
    expect(limits.error).toBe('Cursor usage request failed (HTTP 503)')
    expect(limits.usageMetadata?.failureKind).toBe('server')
  })

  it('classifies an unparseable body as a parse failure, not as usage', async () => {
    netFetchMock.mockResolvedValueOnce(
      fakeResponse({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => {
          throw new Error('invalid json')
        }
      })
    )
    const limits = await fetchCursorRateLimits({ authReadResult: session() })
    expect(limits.usageMetadata?.failureKind).toBe('parse')
  })

  it('publishes an unlimited plan with no misleading bar', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse({ isUnlimited: true, membershipType: 'ultra' }))
    const limits = await fetchCursorRateLimits({ authReadResult: session() })
    expect(limits.status).toBe('ok')
    expect(limits.monthly).toBeUndefined()
    expect(limits.planType).toBe('ultra')
  })

  it('falls back to the request-quota endpoint before declaring no allowance', async () => {
    netFetchMock
      .mockResolvedValueOnce(jsonResponse({ membershipType: 'free' }))
      .mockResolvedValueOnce(jsonResponse({ 'gpt-4': { numRequests: 25, maxRequestUsage: 50 } }))
    const limits = await fetchCursorRateLimits({ authReadResult: session() })
    expect(limits.status).toBe('ok')
    expect(limits.monthly?.usedPercent).toBe(50)
    expect(netFetchMock.mock.calls[1]?.[0]).toBe('https://cursor.com/api/usage?user=auth0%7Cuser_1')
  })

  it('hides the bar for an account with no quota rather than alerting forever', async () => {
    netFetchMock
      .mockResolvedValueOnce(jsonResponse({ membershipType: 'free' }))
      .mockResolvedValueOnce(jsonResponse({}))
    const limits = await fetchCursorRateLimits({ authReadResult: session() })
    expect(limits.status).toBe('unavailable')
    expect(limits.usageMetadata?.failureKind).toBe('usage-unavailable')
  })

  it('reports a network failure without leaking the request internals', async () => {
    netFetchMock.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND cursor.com'))
    const limits = await fetchCursorRateLimits({ authReadResult: session() })
    expect(limits.error).toBe('Cursor usage request failed')
    expect(limits.usageMetadata?.failureKind).toBe('network')
  })
})
