import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setMainHttpClient } from '../network/http-client'
import { fetchClaudeOAuthUsage } from './claude-oauth-usage-request'
import { classifyClaudeOAuthUsageError } from './claude-usage-error-classification'

const fetchMock = vi.fn()

vi.mock('../network/proxy-settings', () => ({
  ensureElectronProxyFromEnvironment: vi.fn(async () => {})
}))

setMainHttpClient({ fetch: fetchMock, proxySession: () => null })

async function fetchUsageResponse(body: string) {
  fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }))
  return fetchClaudeOAuthUsage('oauth-token')
}

describe('Claude OAuth usage extra usage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('maps the usage-credits spend object into a capped balance in major units', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          five_hour: { utilization: 10 },
          spend: {
            used: { amount_minor: 5000, currency: 'EUR', exponent: 2 },
            limit: { amount_minor: 200000, currency: 'EUR', exponent: 2 },
            percent: 2.5,
            enabled: true,
            balance: { amount_minor: 1000, currency: 'EUR', exponent: 2 }
          }
        }),
        { status: 200 }
      )
    )

    await expect(fetchClaudeOAuthUsage('oauth-token')).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      extraUsage: {
        balance: 10,
        spent: 50,
        spendLimit: 2000,
        spentPercent: 2.5,
        currencyCode: 'EUR',
        enabled: true,
        disabledReason: null,
        resetsAt: null
      }
    })
  })

  it('keeps the usage-credits cap visible without inventing an out-of-credits balance', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          five_hour: { utilization: 10 },
          spend: {
            used: { amount_minor: 0, currency: 'EUR', exponent: 2 },
            limit: { amount_minor: 200000, currency: 'EUR', exponent: 2 },
            percent: 0,
            enabled: false,
            disabled_reason: 'out_of_credits',
            balance: null
          }
        }),
        { status: 200 }
      )
    )

    await expect(fetchClaudeOAuthUsage('oauth-token')).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      extraUsage: {
        balance: null,
        spent: 0,
        spendLimit: 2000,
        spentPercent: 0,
        currencyCode: 'EUR',
        enabled: false,
        disabledReason: 'out_of_credits'
      }
    })
  })

  it('keeps legacy extra_usage spend data without inventing a missing balance', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          five_hour: { utilization: 10 },
          extra_usage: {
            is_enabled: true,
            monthly_limit: 200000,
            used_credits: 5000,
            utilization: 2.5,
            currency: 'EUR',
            decimal_places: 2
          }
        }),
        { status: 200 }
      )
    )

    await expect(fetchClaudeOAuthUsage('oauth-token')).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      extraUsage: {
        balance: null,
        spent: 50,
        spendLimit: 2000,
        spentPercent: 2.5,
        currencyCode: 'EUR',
        enabled: true
      }
    })
  })
  it('keeps a missing balance unknown while preserving a known cap', async () => {
    const result = await fetchUsageResponse(
      '{"five_hour":{"utilization":10},"spend":{"limit":{"amount_minor":200000,"currency":"EUR"},"enabled":true}}'
    )
    expect(result.extraUsage).toMatchObject({
      balance: null,
      spendLimit: 2000,
      currencyCode: 'EUR'
    })
  })

  it.each([1000, 0])('preserves a balance-only EUR amount of %s minor units', async (amount) => {
    const result = await fetchUsageResponse(
      JSON.stringify({
        five_hour: { utilization: 10 },
        spend: { balance: { amount_minor: amount, currency: 'EUR' }, enabled: true }
      })
    )
    expect(result.extraUsage).toMatchObject({
      balance: amount / 100,
      currencyCode: 'EUR',
      spendLimit: null
    })
  })

  it('keeps a numeric overflow balance unknown and derives a finite percentage', async () => {
    const result = await fetchUsageResponse(
      '{"five_hour":{"utilization":10},"spend":{"used":{"amount_minor":5000},"limit":{"amount_minor":200000},"balance":{"amount_minor":1e309},"percent":1e309,"enabled":true}}'
    )
    expect(result.extraUsage).toMatchObject({
      balance: null,
      spent: 50,
      spendLimit: 2000,
      spentPercent: 2.5
    })
  })

  it('keeps nullable legacy spend unknown despite a supplied percentage', async () => {
    const result = await fetchUsageResponse(
      '{"five_hour":{"utilization":10},"extra_usage":{"monthly_limit":200000,"used_credits":null,"utilization":10,"currency":"EUR","is_enabled":true}}'
    )
    expect(result.extraUsage).toMatchObject({
      balance: null,
      spent: null,
      spendLimit: 2000,
      spentPercent: 10
    })
  })

  it('derives legacy percentage when the response percentage overflows', async () => {
    const result = await fetchUsageResponse(
      '{"five_hour":{"utilization":10},"extra_usage":{"monthly_limit":200000,"used_credits":5000,"utilization":1e309,"currency":"EUR","is_enabled":true}}'
    )
    expect(result.extraUsage).toMatchObject({
      balance: null,
      spent: 50,
      spendLimit: 2000,
      spentPercent: 2.5
    })
  })

  it('does not turn an overflowing legacy spend into a known amount', async () => {
    const result = await fetchUsageResponse(
      '{"five_hour":{"utilization":10},"extra_usage":{"monthly_limit":200000,"used_credits":1e309,"currency":"EUR","is_enabled":true}}'
    )
    expect(result.extraUsage).toMatchObject({
      balance: null,
      spent: null,
      spendLimit: 2000,
      spentPercent: null
    })
  })

  it.each(['null', '1e309'])('omits a legacy cap whose amount is %s', async (limit) => {
    const result = await fetchUsageResponse(
      `{"five_hour":{"utilization":10},"extra_usage":{"monthly_limit":${limit},"used_credits":5000,"currency":"EUR","is_enabled":true}}`
    )
    expect(result.extraUsage ?? null).toBeNull()
  })

  it.each([-1, 0.5, 309])(
    'omits malformed legacy precision %s rather than displaying zero',
    async (exponent) => {
      const result = await fetchUsageResponse(
        JSON.stringify({
          five_hour: { utilization: 10 },
          extra_usage: {
            monthly_limit: 200000,
            used_credits: 5000,
            decimal_places: exponent,
            currency: 'EUR',
            is_enabled: true
          }
        })
      )
      expect(result.extraUsage ?? null).toBeNull()
    }
  )

  it('shows the spend cap as the monthly window when the plan has no 5h or 7d window', async () => {
    const result = await fetchUsageResponse(
      JSON.stringify({
        five_hour: null,
        seven_day: null,
        limits: [],
        spend: {
          used: { amount_minor: 40000, currency: 'USD', exponent: 2 },
          limit: { amount_minor: 50000, currency: 'USD', exponent: 2 },
          percent: 80,
          enabled: true
        }
      })
    )
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
    expect(result.monthly).toEqual({
      usedPercent: 80,
      windowMinutes: 43_200,
      resetsAt: null,
      resetDescription: null
    })
  })

  it('derives the monthly window from legacy extra_usage when spend is absent', async () => {
    const result = await fetchUsageResponse(
      '{"five_hour":null,"seven_day":null,"extra_usage":{"monthly_limit":50000,"used_credits":40000,"utilization":80,"currency":"USD","is_enabled":true}}'
    )
    expect(result.monthly).toMatchObject({ usedPercent: 80, windowMinutes: 43_200 })
  })

  it('falls back to the legacy cap when spend carries only a balance', async () => {
    const result = await fetchUsageResponse(
      JSON.stringify({
        five_hour: null,
        seven_day: null,
        spend: { balance: { amount_minor: 1000, currency: 'USD' }, enabled: true },
        extra_usage: {
          monthly_limit: 50000,
          used_credits: 40000,
          utilization: 80,
          currency: 'USD',
          is_enabled: true
        }
      })
    )
    expect(result.extraUsage).toMatchObject({ balance: 10, spendLimit: null })
    expect(result.monthly).toMatchObject({ usedPercent: 80, windowMinutes: 43_200 })
  })

  it('derives legacy percentage from the amounts when utilization is a fraction', async () => {
    const result = await fetchUsageResponse(
      '{"five_hour":null,"seven_day":null,"extra_usage":{"monthly_limit":5000,"used_credits":479,"utilization":0.0958,"currency":"USD","is_enabled":true}}'
    )
    expect(result.extraUsage).toMatchObject({ spentPercent: expect.closeTo(9.58) })
    expect(result.monthly?.usedPercent).toBeCloseTo(9.58)
  })

  it('keeps spend out of the monthly window when a plan window exists', async () => {
    const result = await fetchUsageResponse(
      '{"five_hour":{"utilization":10},"seven_day":null,"spend":{"used":{"amount_minor":5000},"limit":{"amount_minor":200000},"percent":2.5,"enabled":true}}'
    )
    expect(result.extraUsage).toMatchObject({ spentPercent: 2.5 })
    expect(result.monthly).toBeNull()
  })

  it('does not invent a monthly window from a balance without a cap', async () => {
    const result = await fetchUsageResponse(
      '{"five_hour":null,"seven_day":null,"spend":{"balance":{"amount_minor":1000,"currency":"EUR"},"enabled":true}}'
    )
    expect(result.extraUsage).toMatchObject({ balance: 10, spendLimit: null })
    expect(result.monthly).toBeNull()
  })

  it('classifies only the request: a dead proxy is network, a null 200 body stays unknown', async () => {
    fetchMock.mockRejectedValueOnce(new Error('net::ERR_PROXY_CONNECTION_FAILED'))
    const transport = await fetchClaudeOAuthUsage('oauth-token').catch((error: unknown) => error)
    expect(classifyClaudeOAuthUsageError(transport).failureKind).toBe('network')

    const nullBody = await fetchUsageResponse('null').catch((error: unknown) => error)
    expect(classifyClaudeOAuthUsageError(nullBody).failureKind).toBe('unknown')
  })
})
