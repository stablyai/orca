import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CursorAuthReadResult } from './cursor-auth'

const netFetchMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

import { fetchCursorRateLimits } from './cursor-fetcher'
/** Fetch Response stub returning JSON for cursor-fetcher tests. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response
}

const OK_AUTH: CursorAuthReadResult = {
  status: 'ok',
  accessToken: 'cursor-access-token',
  source: 'cli'
}

const OK_AUTH_IDE: CursorAuthReadResult = {
  status: 'ok',
  accessToken: 'cursor-access-token',
  source: 'ide'
}

describe('fetchCursorRateLimits', () => {
  beforeEach(() => {
    netFetchMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns unavailable with no HTTP call when auth is missing', async () => {
    const result = await fetchCursorRateLimits({ authReadResult: { status: 'missing' } })

    expect(result.provider).toBe('cursor')
    expect(result.status).toBe('unavailable')
    expect(result.usageMetadata?.failureKind).toBe('missing-credentials')
    expect(result.usageMetadata?.source).toBe('cli')
    expect(result.error).toMatch(/not signed in to cursor/i)
    expect(result.error).toMatch(/cursor-agent/i)
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('maps totalPercentUsed and billingCycleEnd to a monthly window', async () => {
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        planUsage: { totalPercentUsed: 6.1 },
        billingCycleEnd: '1771077734000'
      })
    )

    const result = await fetchCursorRateLimits({ authReadResult: OK_AUTH })

    expect(result.status).toBe('ok')
    expect(result.error).toBeNull()
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
    expect(result.monthly?.usedPercent).toBe(6.1)
    expect(result.monthly?.resetsAt).toBe(1771077734000)
    expect(result.monthly?.windowMinutes).toBe(43_200)
    expect(result.buckets).toBeUndefined()

    expect(netFetchMock).toHaveBeenCalledWith(
      'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({}),
        headers: expect.objectContaining({
          Authorization: 'Bearer cursor-access-token',
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1'
        })
      })
    )
  })

  it('maps an IDE-sourced ok auth to usageMetadata.source "web" on success', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse({ planUsage: { totalPercentUsed: 6.1 } }))

    const result = await fetchCursorRateLimits({ authReadResult: OK_AUTH_IDE })

    expect(result.status).toBe('ok')
    expect(result.usageMetadata?.source).toBe('web')
  })

  it('maps a CLI-sourced ok auth to usageMetadata.source "cli" on success', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse({ planUsage: { totalPercentUsed: 6.1 } }))

    const result = await fetchCursorRateLimits({ authReadResult: OK_AUTH })

    expect(result.status).toBe('ok')
    expect(result.usageMetadata?.source).toBe('cli')
  })

  it('treats 10-digit billingCycleEnd as unix seconds', async () => {
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        planUsage: { totalPercentUsed: 6.1 },
        billingCycleEnd: '1771077734'
      })
    )

    const result = await fetchCursorRateLimits({ authReadResult: OK_AUTH })

    expect(result.status).toBe('ok')
    expect(result.monthly?.resetsAt).toBe(1_771_077_734_000)
  })

  it('parses ISO billingCycleEnd strings', async () => {
    const end = Date.parse('2026-08-01T00:00:00Z')
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        planUsage: { totalPercentUsed: 6.1 },
        billingCycleEnd: '2026-08-01T00:00:00Z'
      })
    )

    const result = await fetchCursorRateLimits({ authReadResult: OK_AUTH })

    expect(result.status).toBe('ok')
    expect(result.monthly?.resetsAt).toBe(end)
  })

  it('computes windowMinutes from billingCycleStart/End when both parse', async () => {
    const start = Date.parse('2026-07-01T00:00:00Z')
    const end = Date.parse('2026-08-01T00:00:00Z')
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        planUsage: { totalPercentUsed: 10 },
        billingCycleStart: String(start),
        billingCycleEnd: String(end)
      })
    )

    const result = await fetchCursorRateLimits({ authReadResult: OK_AUTH })

    expect(result.status).toBe('ok')
    expect(result.monthly?.windowMinutes).toBe((end - start) / 60_000)
  })

  it('returns a stale-token error on 401 without leaking the token', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse({}, 401))

    const result = await fetchCursorRateLimits({ authReadResult: OK_AUTH })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('stale-token')
    expect(result.usageMetadata?.source).toBe('cli')
    expect(result.error).toMatch(/cursor-agent/i)
    expect(result.error).not.toContain('cursor-access-token')
  })

  it('keeps usageMetadata.source "web" for a 401 with an IDE-sourced auth result', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse({}, 401))

    const result = await fetchCursorRateLimits({ authReadResult: OK_AUTH_IDE })

    expect(result.usageMetadata?.failureKind).toBe('stale-token')
    expect(result.usageMetadata?.source).toBe('web')
  })

  it('returns a stale-token error on 403', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse({}, 403))

    const result = await fetchCursorRateLimits({ authReadResult: OK_AUTH })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('stale-token')
  })

  it('maps auto/api percents to named buckets', async () => {
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        planUsage: { totalPercentUsed: 15.48, autoPercentUsed: 3.9, apiPercentUsed: 2.6 },
        billingCycleEnd: '1771077734000'
      })
    )

    const result = await fetchCursorRateLimits({ authReadResult: OK_AUTH })

    expect(result.status).toBe('ok')
    expect(result.buckets).toEqual([
      expect.objectContaining({ name: 'Cursor Models', usedPercent: 3.9 }),
      expect.objectContaining({ name: 'Other models', usedPercent: 2.6 })
    ])
  })

  it('omits buckets when auto/api percents are absent', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse({ planUsage: { totalPercentUsed: 5 } }))

    const result = await fetchCursorRateLimits({ authReadResult: OK_AUTH })

    expect(result.buckets).toBeUndefined()
  })

  it('returns a parse error when planUsage.totalPercentUsed is missing', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse({ planUsage: {} }))

    const result = await fetchCursorRateLimits({ authReadResult: OK_AUTH })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('parse')
  })

  it('returns a parse error when the response body cannot be parsed as JSON', async () => {
    netFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token')
      }
    } as unknown as Response)

    const result = await fetchCursorRateLimits({ authReadResult: OK_AUTH })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('parse')
    expect(result.usageMetadata?.source).toBe('cli')
  })

  it('keeps usageMetadata.source "web" for a parse failure with an IDE-sourced auth result', async () => {
    netFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token')
      }
    } as unknown as Response)

    const result = await fetchCursorRateLimits({ authReadResult: OK_AUTH_IDE })

    expect(result.usageMetadata?.failureKind).toBe('parse')
    expect(result.usageMetadata?.source).toBe('web')
  })

  it('clamps usedPercent into the 0-100 range', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse({ planUsage: { totalPercentUsed: 142 } }))

    const result = await fetchCursorRateLimits({ authReadResult: OK_AUTH })

    expect(result.monthly?.usedPercent).toBe(100)
  })

  it('sets planType when a string plan field is present', async () => {
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({ planUsage: { totalPercentUsed: 5 }, planType: 'pro' })
    )

    const result = await fetchCursorRateLimits({ authReadResult: OK_AUTH })

    expect(result.planType).toBe('pro')
  })

  it('omits planType when no plan field is present', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse({ planUsage: { totalPercentUsed: 5 } }))

    const result = await fetchCursorRateLimits({ authReadResult: OK_AUTH })

    expect(result.planType).toBeUndefined()
  })

  it('surfaces a network failure when the request throws', async () => {
    netFetchMock.mockRejectedValueOnce(new Error('network down'))

    const result = await fetchCursorRateLimits({ authReadResult: OK_AUTH })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('network')
    expect(result.error).toBe('network down')
  })

  it('surfaces the auth error result when reading the session failed', async () => {
    const result = await fetchCursorRateLimits({
      authReadResult: { status: 'error', error: 'Unable to read Cursor auth' }
    })

    expect(result.status).toBe('error')
    expect(result.error).toBe('Unable to read Cursor auth')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('aborts the dashboard request when the caller aborts', async () => {
    const controller = new AbortController()
    let requestSignal: AbortSignal | undefined
    netFetchMock.mockImplementationOnce((_url, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal
      return new Promise((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    })

    const resultPromise = fetchCursorRateLimits({
      authReadResult: OK_AUTH,
      signal: controller.signal
    })
    await Promise.resolve()
    controller.abort()

    const result = await resultPromise
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('network')
  })
})
