import { beforeEach, describe, expect, it, vi } from 'vitest'

const netFetchMock = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ net: { fetch: netFetchMock } }))
vi.mock('./grok-auth', () => ({
  readGrokAuthSession: () => {
    throw new Error('Tests must supply synthetic auth')
  },
  isGrokAccessTokenFresh: () => true
}))

import { fetchGrokRateLimits } from './grok-fetcher'

const START = '2026-09-13T16:33:14.392197+00:00'
const END = '2026-09-20T16:33:14.392197+00:00'
const PERIOD = { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: START, end: END }
const CONFIRMED_PERIOD = {
  currentPeriod: PERIOD,
  billingPeriodStart: START,
  billingPeriodEnd: END
}
// Reporter deminit02-hue's #20657 payload; authentication is synthetic.
const REPORTER_CONFIG = {
  ...CONFIRMED_PERIOD,
  onDemandCap: { val: 0 },
  onDemandUsed: { val: 0 },
  prepaidBalance: { val: 0 },
  isUnifiedBillingUser: true
}
const AUTH = {
  status: 'ok',
  session: {
    accessToken: 'fixture-only',
    userId: 'fixture-user',
    email: 'grok@example.invalid',
    teamId: null,
    oidcClientId: null,
    expiresAtMs: Date.parse('2099-01-01T00:00:00Z')
  }
} as const

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

async function fetchConfig(config: Record<string, unknown>, flat = false) {
  netFetchMock
    .mockResolvedValueOnce(jsonResponse(flat ? config : { config }))
    .mockResolvedValueOnce(jsonResponse({ config: {} }))
  return fetchGrokRateLimits({ authReadResult: AUTH })
}

describe('Grok weekly zero evidence', () => {
  beforeEach(() => netFetchMock.mockReset())

  it.each([false, true])('maps the reporter payload with flat=%s', async (flat) => {
    const result = await fetchConfig(REPORTER_CONFIG, flat)
    expect(result.status).toBe('ok')
    expect(result.weekly).toMatchObject({
      usedPercent: 0,
      windowMinutes: 10_080,
      resetsAt: Date.parse(END)
    })
    expect(result.monthly).toBeUndefined()
    expect(netFetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([0, '0', '0.00'])('accepts money zero encoded as %s', async (val) => {
    const result = await fetchConfig({
      ...REPORTER_CONFIG,
      onDemandCap: { val },
      onDemandUsed: { val },
      prepaidBalance: { val }
    })
    expect(result.weekly?.usedPercent).toBe(0)
    expect(netFetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    { name: 'absent', cap: undefined },
    { name: 'empty', cap: {} },
    { name: 'malformed', cap: { val: 'unknown' } },
    { name: 'zero prefix', cap: { val: '0invalid' } },
    { name: 'negative', cap: { val: -1 } },
    { name: 'nonfinite', cap: { val: Infinity } },
    { name: 'positive', cap: { val: 250 } }
  ])('keeps $name cap with explicit money zeros unknown', async ({ cap }) => {
    const result = await fetchConfig({ ...REPORTER_CONFIG, onDemandCap: cap })
    expect(result.status).toBe('unavailable')
    expect(result.weekly).toBeNull()
    expect(netFetchMock).toHaveBeenCalledTimes(2)
  })

  it.each(['onDemandUsed', 'used'])('does not infer zero beside positive %s', async (field) => {
    const result = await fetchConfig({ ...REPORTER_CONFIG, [field]: { val: '37.5' } })
    expect(result.status).toBe('unavailable')
    expect(result.weekly).toBeNull()
    expect(netFetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    { name: 'absent cap and no money', config: CONFIRMED_PERIOD },
    { name: 'prepaid only', config: { ...CONFIRMED_PERIOD, prepaidBalance: { val: 25 } } },
    { name: 'zero cap and prepaid', config: { ...REPORTER_CONFIG, prepaidBalance: { val: 25 } } }
  ])('preserves $name zero inference', async ({ config }) => {
    const result = await fetchConfig(config)
    expect(result.weekly?.usedPercent).toBe(0)
    expect(netFetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([0, 23, -10, 150])(
    'honors finite explicit percent %s before money evidence',
    async (percent) => {
      const result = await fetchConfig({
        ...REPORTER_CONFIG,
        creditUsagePercent: percent,
        onDemandUsed: { val: 37.5 },
        monthlyLimit: { val: 100 },
        used: { val: 25 },
        billingPeriodStart: undefined
      })
      expect(result.weekly?.usedPercent).toBe(Math.min(100, Math.max(0, percent)))
      expect(result.monthly).toBeUndefined()
      expect(netFetchMock).toHaveBeenCalledTimes(1)
    }
  )

  it.each([null, '0', 'invalid', Number.NaN, Infinity, -Infinity])(
    'does not infer an invalid explicit percent %s',
    async (percent) => {
      const result = await fetchConfig({ ...REPORTER_CONFIG, creditUsagePercent: percent })
      expect(result.status).toBe('unavailable')
      expect(result.weekly).toBeNull()
      expect(netFetchMock).toHaveBeenCalledTimes(2)
    }
  )

  it.each([
    { billingPeriodStart: undefined },
    { billingPeriodEnd: undefined },
    { billingPeriodStart: 'invalid' },
    { billingPeriodEnd: 'invalid' },
    { billingPeriodStart: END },
    { billingPeriodEnd: START },
    { currentPeriod: undefined },
    { currentPeriod: { ...PERIOD, type: 'USAGE_PERIOD_TYPE_MONTHLY' } },
    { currentPeriod: { ...PERIOD, start: 'invalid' } },
    { currentPeriod: { ...PERIOD, end: 'invalid' } }
  ])('requires confirmed weekly bounds: %o', async (period) => {
    const result = await fetchConfig({ ...REPORTER_CONFIG, ...period })
    expect(result.status).toBe('unavailable')
    expect(result.weekly).toBeNull()
    expect(netFetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([0, 25])('keeps a computable monthly pair with used=%s monthly', async (used) => {
    const result = await fetchConfig({
      ...REPORTER_CONFIG,
      monthlyLimit: { val: '100' },
      used: { val: used }
    })
    expect(result.status).toBe('ok')
    expect(result.weekly).toBeNull()
    expect(result.monthly).toMatchObject({ usedPercent: used, windowMinutes: 43_200 })
    expect(netFetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([0, '0', -1, 'invalid', null, Infinity, Number.NaN])(
    'rejects invalid monthly denominator %s',
    async (val) => {
      netFetchMock
        .mockResolvedValueOnce(jsonResponse({ config: { subscriptionTier: 'Fixture' } }))
        .mockResolvedValueOnce(
          jsonResponse({ config: { monthlyLimit: { val }, used: { val: 12 } } })
        )
      const result = await fetchGrokRateLimits({ authReadResult: AUTH })
      expect(result.status).toBe('unavailable')
      expect(result.weekly).toBeNull()
      expect(result.monthly).toBeUndefined()
      expect(netFetchMock).toHaveBeenCalledTimes(2)
    }
  )

  it.each([false, true])('preserves monthly fallback with flat=%s', async (flat) => {
    const config = { monthlyLimit: { val: 200 }, used: { val: 50 }, billingPeriodEnd: END }
    netFetchMock
      .mockResolvedValueOnce(
        jsonResponse({ config: { ...REPORTER_CONFIG, onDemandCap: { val: 250 } } })
      )
      .mockResolvedValueOnce(jsonResponse(flat ? config : { config }))
    const result = await fetchGrokRateLimits({ authReadResult: AUTH })
    expect(result.status).toBe('ok')
    expect(result.weekly).toBeNull()
    expect(result.monthly).toMatchObject({ usedPercent: 25, resetsAt: Date.parse(END) })
    expect(netFetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([401, 403, 500])('preserves fallback HTTP %s errors', async (status) => {
    netFetchMock
      .mockResolvedValueOnce(jsonResponse({ config: { subscriptionTier: 'Fixture' } }))
      .mockResolvedValueOnce(jsonResponse({}, status))
    const result = await fetchGrokRateLimits({ authReadResult: AUTH })
    expect(result.status).toBe('error')
    expect(result.error).toContain(`HTTP ${status}`)
    expect(netFetchMock).toHaveBeenCalledTimes(2)
  })

  it('aborts the default billing fallback with the caller signal', async () => {
    const controller = new AbortController()
    let signal: AbortSignal | null | undefined
    netFetchMock
      .mockResolvedValueOnce(jsonResponse({ config: { subscriptionTier: 'Fixture' } }))
      .mockImplementationOnce((_url, init: RequestInit) => {
        signal = init.signal
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      })
    const pending = fetchGrokRateLimits({ authReadResult: AUTH, signal: controller.signal })
    await vi.waitFor(() => expect(netFetchMock).toHaveBeenCalledTimes(2))
    controller.abort()
    expect(signal?.aborted).toBe(true)
    expect(await pending).toMatchObject({ status: 'error', error: 'aborted' })
  })
})
