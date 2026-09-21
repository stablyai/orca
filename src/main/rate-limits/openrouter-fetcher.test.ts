import { beforeEach, describe, expect, it, vi } from 'vitest'

const netFetchMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

import { fetchOpenRouterRateLimits } from './openrouter-fetcher'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response
}

/** Field set captured from a live key with a $40/month cap. */
function keyPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    data: {
      limit: 40,
      limit_remaining: 28.975375764,
      limit_reset: 'monthly',
      usage: 11.024624236,
      usage_monthly: 11.024624236,
      is_free_tier: false,
      rate_limit: { requests: -1, interval: '10s', note: 'This field is deprecated' },
      ...overrides
    }
  }
}

beforeEach(() => {
  netFetchMock.mockReset()
})

describe('fetchOpenRouterRateLimits', () => {
  it('meters period spend against the key cap', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse(keyPayload()))

    const limits = await fetchOpenRouterRateLimits({ apiKey: 'sk-or-test' })

    expect(limits.status).toBe('ok')
    // (40 - 28.975…) / 40 = 27.56%
    expect(limits.monthly?.usedPercent).toBeCloseTo(27.56, 2)
    expect(limits.monthly?.windowMinutes).toBe(43_200)
    expect(limits.planType).toBe('monthly')
  })

  it('derives spend from limit_remaining, not lifetime usage', async () => {
    // A key whose cap has rolled over: lifetime usage far exceeds the cap while
    // the current period is barely touched. Using `usage` would read 100%.
    netFetchMock.mockResolvedValueOnce(
      jsonResponse(keyPayload({ usage: 910.5, limit: 40, limit_remaining: 36 }))
    )

    const limits = await fetchOpenRouterRateLimits({ apiKey: 'sk-or-test' })

    expect(limits.status).toBe('ok')
    expect(limits.monthly?.usedPercent).toBeCloseTo(10, 5)
  })

  it('carries no reset timestamp, because OpenRouter reports only a cadence', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse(keyPayload()))

    const limits = await fetchOpenRouterRateLimits({ apiKey: 'sk-or-test' })

    // Why: `limit_reset` is the word "monthly" — inventing an instant here
    // would put a countdown on screen that OpenRouter never promised.
    expect(limits.monthly?.resetsAt).toBeNull()
    expect(limits.monthly?.resetDescription).toBeNull()
  })

  it('reports unavailable when no key is configured', async () => {
    const limits = await fetchOpenRouterRateLimits({ apiKey: null })

    expect(limits.status).toBe('unavailable')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('treats a rejected key as an error with a stale-token hint', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse(null, 401))

    const limits = await fetchOpenRouterRateLimits({ apiKey: 'sk-or-bad' })

    expect(limits.status).toBe('error')
    expect(limits.usageMetadata?.failureKind).toBe('stale-token')
  })

  it('classifies a 429 as rate-limited so the stale policy keeps prior data', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse(null, 429))

    const limits = await fetchOpenRouterRateLimits({ apiKey: 'sk-or-test' })

    expect(limits.status).toBe('error')
    expect(limits.usageMetadata?.failureKind).toBe('rate-limited')
  })

  it('falls back to the account credit balance for an uncapped key', async () => {
    netFetchMock
      .mockResolvedValueOnce(jsonResponse(keyPayload({ limit: null, limit_remaining: null })))
      .mockResolvedValueOnce(jsonResponse({ data: { total_credits: 50, total_usage: 20 } }))

    const limits = await fetchOpenRouterRateLimits({ apiKey: 'sk-or-test' })

    expect(limits.status).toBe('ok')
    expect(limits.monthly?.usedPercent).toBeCloseTo(40, 5)
    expect(netFetchMock.mock.calls[1]?.[0]).toBe('https://openrouter.ai/api/v1/credits')
  })

  it('hides the bar for an uncapped key with no credits', async () => {
    netFetchMock
      .mockResolvedValueOnce(jsonResponse(keyPayload({ limit: null, limit_remaining: null })))
      .mockResolvedValueOnce(jsonResponse({ data: { total_credits: 0, total_usage: 0 } }))

    const limits = await fetchOpenRouterRateLimits({ apiKey: 'sk-or-test' })

    // Why: a working key with no ceiling is not an error — metering 0% of
    // nothing would be worse than showing no bar.
    expect(limits.status).toBe('unavailable')
    expect(limits.monthly).toBeUndefined()
  })

  it('reports a failed credits read as an error, not as "no cap"', async () => {
    // Why: with no cap on the key the balance is the only ceiling left, so a
    // 429 there means the headroom is unknown rather than absent. Reporting
    // 'unavailable' would also drop the previous reading.
    netFetchMock
      .mockResolvedValueOnce(jsonResponse(keyPayload({ limit: null, limit_remaining: null })))
      .mockResolvedValueOnce(jsonResponse(null, 429))

    const limits = await fetchOpenRouterRateLimits({ apiKey: 'sk-or-test' })

    expect(limits.status).toBe('error')
    expect(limits.usageMetadata?.failureKind).toBe('rate-limited')
  })

  it('surfaces a network failure as an error rather than throwing', async () => {
    netFetchMock.mockRejectedValueOnce(new Error('socket hang up'))

    const limits = await fetchOpenRouterRateLimits({ apiKey: 'sk-or-test' })

    expect(limits.status).toBe('error')
    expect(limits.error).toBe('socket hang up')
    expect(limits.usageMetadata?.failureKind).toBe('network')
  })

  it('sends the key as a bearer token', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse(keyPayload()))

    await fetchOpenRouterRateLimits({ apiKey: 'sk-or-test' })

    const [url, init] = netFetchMock.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(url).toBe('https://openrouter.ai/api/v1/key')
    expect(init.headers.Authorization).toBe('Bearer sk-or-test')
  })
})
