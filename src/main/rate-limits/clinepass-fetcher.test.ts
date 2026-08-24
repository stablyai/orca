import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const netFetchMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

import { fetchClinePassRateLimits } from './clinepass-fetcher'

const USAGE_URL = 'https://api.cline.bot/api/v1/users/me/plan/usage-limits'
const API_KEY = 'cpk-test-secret-key'

const SESSION_RESET = '2026-08-11T18:00:00.000Z'
const WEEKLY_RESET = '2026-08-18T12:00:00.000Z'
const MONTHLY_RESET = '2026-09-01T00:00:00.000Z'

function makeOkPayload(limits: { type: string; percentUsed: number; resetsAt: string }[]): unknown {
  return {
    success: true,
    data: { limits }
  }
}

const FULL_LIMITS = [
  { type: 'five_hour', percentUsed: 42.5, resetsAt: SESSION_RESET },
  { type: 'weekly', percentUsed: 10, resetsAt: WEEKLY_RESET },
  { type: 'monthly', percentUsed: 3, resetsAt: MONTHLY_RESET }
]

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers
    }
  })
}

describe('fetchClinePassRateLimits', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-11T12:00:00.000Z'))
    netFetchMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('returns unavailable with missing-credentials when the key is blank', async () => {
    for (const key of ['', '   ']) {
      const result = await fetchClinePassRateLimits(key)
      expect(result).toMatchObject({
        provider: 'clinepass',
        status: 'unavailable',
        session: null,
        weekly: null,
        error: expect.stringMatching(/not configured/i),
        usageMetadata: { failureKind: 'missing-credentials', source: 'web' }
      })
    }
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('requests the usage-limits URL with a bearer Authorization header', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse(makeOkPayload(FULL_LIMITS)))

    await fetchClinePassRateLimits(API_KEY)

    expect(netFetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = netFetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(USAGE_URL)
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`)
    expect((init.headers as Record<string, string>).Accept).toBe('application/json')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('maps five_hour, weekly, and monthly windows with reset timestamps', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse(makeOkPayload(FULL_LIMITS)))

    const result = await fetchClinePassRateLimits(API_KEY)

    expect(result.status).toBe('ok')
    expect(result.provider).toBe('clinepass')
    expect(result.error).toBeNull()
    expect(result.usageMetadata).toEqual({ source: 'web' })
    expect(result.session).toEqual({
      usedPercent: 42.5,
      windowMinutes: 300,
      resetsAt: Date.parse(SESSION_RESET),
      resetDescription: expect.any(String)
    })
    expect(result.weekly).toEqual({
      usedPercent: 10,
      windowMinutes: 10_080,
      resetsAt: Date.parse(WEEKLY_RESET),
      resetDescription: expect.any(String)
    })
    expect(result.monthly).toEqual({
      usedPercent: 3,
      windowMinutes: 43_200,
      resetsAt: Date.parse(MONTHLY_RESET),
      resetDescription: expect.any(String)
    })
  })

  it('clamps percentUsed into the 0..100 range', async () => {
    netFetchMock.mockResolvedValueOnce(
      jsonResponse(
        makeOkPayload([
          { type: 'five_hour', percentUsed: -12, resetsAt: SESSION_RESET },
          { type: 'weekly', percentUsed: 150, resetsAt: WEEKLY_RESET }
        ])
      )
    )

    const result = await fetchClinePassRateLimits(API_KEY)

    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(0)
    expect(result.weekly?.usedPercent).toBe(100)
  })

  it('classifies 401 and 403 as stale-token auth errors', async () => {
    for (const status of [401, 403]) {
      netFetchMock.mockResolvedValueOnce(jsonResponse({}, status))
      const result = await fetchClinePassRateLimits(API_KEY)
      expect(result.status).toBe('error')
      expect(result.usageMetadata?.failureKind).toBe('stale-token')
      expect(result.usageMetadata?.source).toBe('web')
      expect(result.error).toMatch(new RegExp(`unauthorized.*${status}`, 'i'))
      expect(result.error).not.toContain(API_KEY)
    }
  })

  it('classifies 429 as rate-limited and honors parseable Retry-After', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse({}, 429, { 'retry-after': '120' }))

    const before = Date.now()
    const result = await fetchClinePassRateLimits(API_KEY)

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('rate-limited')
    expect(result.usageMetadata?.source).toBe('web')
    expect(result.error).toMatch(/rate limited/i)
    expect(result.usageMetadata?.retryAtMs).toBeGreaterThanOrEqual(before + 120_000)
    expect(result.usageMetadata?.retryAtMs).toBeLessThanOrEqual(Date.now() + 120_000)
  })

  it('omits retryAtMs when a 429 has no parseable Retry-After', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse({}, 429))

    const result = await fetchClinePassRateLimits(API_KEY)

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('rate-limited')
    expect(result.usageMetadata?.retryAtMs).toBeUndefined()
  })

  it('classifies 5xx responses as server errors', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse({}, 503))

    const result = await fetchClinePassRateLimits(API_KEY)

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('server')
    expect(result.error).toMatch(/503/)
    expect(result.error).not.toContain(API_KEY)
  })

  it('classifies thrown fetch failures as network errors without leaking the key', async () => {
    netFetchMock.mockRejectedValueOnce(new Error(`connect failed for ${API_KEY}`))

    const result = await fetchClinePassRateLimits(API_KEY)

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('network')
    expect(result.error).toMatch(/connect failed/)
    expect(result.error).not.toContain(API_KEY)
    expect(result.error).toContain('[redacted]')
  })

  it('classifies malformed success bodies as parse errors', async () => {
    const cases: unknown[] = [
      null,
      { success: false, data: { limits: FULL_LIMITS } },
      { success: true, data: null },
      { success: true, data: {} },
      { success: true, data: { limits: 'nope' } },
      {
        success: true,
        data: { limits: [{ type: 'five_hour', percentUsed: 'x', resetsAt: SESSION_RESET }] }
      },
      {
        success: true,
        data: {
          limits: [{ type: 'five_hour', percentUsed: 10, resetsAt: 'not-a-date' }]
        }
      }
    ]

    for (const body of cases) {
      netFetchMock.mockResolvedValueOnce(jsonResponse(body))
      const result = await fetchClinePassRateLimits(API_KEY)
      expect(result.status).toBe('error')
      expect(result.usageMetadata?.failureKind).toBe('parse')
      expect(result.session).toBeNull()
      expect(result.weekly).toBeNull()
    }
  })

  it('ignores unknown window types and requires at least one known valid window', async () => {
    netFetchMock.mockResolvedValueOnce(
      jsonResponse(
        makeOkPayload([
          { type: 'daily', percentUsed: 50, resetsAt: SESSION_RESET },
          { type: 'five_hour', percentUsed: 22, resetsAt: SESSION_RESET }
        ])
      )
    )
    const ok = await fetchClinePassRateLimits(API_KEY)
    expect(ok.status).toBe('ok')
    expect(ok.session?.usedPercent).toBe(22)
    expect(ok.weekly).toBeNull()
    expect(ok.monthly).toBeNull()

    netFetchMock.mockResolvedValueOnce(
      jsonResponse(makeOkPayload([{ type: 'daily', percentUsed: 50, resetsAt: SESSION_RESET }]))
    )
    const onlyUnknown = await fetchClinePassRateLimits(API_KEY)
    expect(onlyUnknown.status).toBe('error')
    expect(onlyUnknown.usageMetadata?.failureKind).toBe('parse')
  })

  it('composes the caller AbortSignal with the 15s timeout', async () => {
    const timeoutSignal = AbortSignal.abort(
      new DOMException('The operation timed out.', 'TimeoutError')
    )
    const anySpy = vi.spyOn(AbortSignal, 'any').mockReturnValue(timeoutSignal)
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal)

    const controller = new AbortController()
    netFetchMock.mockImplementation((_url: string, init: { signal: AbortSignal }) => {
      const { promise, reject } = Promise.withResolvers<Response>()
      const abort = (): void => {
        reject(new DOMException('The operation was aborted.', 'AbortError'))
      }
      if (init.signal.aborted) {
        abort()
      } else {
        init.signal.addEventListener('abort', abort, { once: true })
      }
      return promise
    })

    const result = await fetchClinePassRateLimits(API_KEY, { signal: controller.signal })

    expect(timeoutSpy).toHaveBeenCalledWith(15_000)
    expect(anySpy.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([controller.signal, timeoutSignal])
    )
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('network')
  })
})
