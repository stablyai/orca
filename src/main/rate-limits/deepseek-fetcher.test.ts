import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const netFetchMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

import {
  fetchDeepSeekRateLimits,
  isDeepSeekAuthConfigured,
  readDeepSeekApiKey
} from './deepseek-fetcher'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response
}

const USD_BALANCE = {
  is_available: true,
  balance_infos: [
    {
      currency: 'CNY',
      total_balance: '50.00',
      granted_balance: '0.00',
      topped_up_balance: '50.00'
    },
    {
      currency: 'USD',
      total_balance: '110.00',
      granted_balance: '10.00',
      topped_up_balance: '100.00'
    }
  ]
}

describe('deepseek-fetcher', () => {
  beforeEach(() => {
    netFetchMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('reads a trimmed DEEPSEEK_API_KEY', () => {
    expect(readDeepSeekApiKey({ DEEPSEEK_API_KEY: '  sk-test  ' })).toBe('sk-test')
    expect(readDeepSeekApiKey({ DEEPSEEK_API_KEY: '   ' })).toBeNull()
    expect(readDeepSeekApiKey({})).toBeNull()
    expect(isDeepSeekAuthConfigured({ DEEPSEEK_API_KEY: 'sk' })).toBe(true)
    expect(isDeepSeekAuthConfigured({})).toBe(false)
  })

  it('returns unavailable when no API key is set', async () => {
    const result = await fetchDeepSeekRateLimits({ env: {} })
    expect(result.provider).toBe('deepseek')
    expect(result.status).toBe('unavailable')
    expect(result.error).toMatch(/DEEPSEEK_API_KEY/)
    expect(result.usageMetadata?.failureKind).toBe('missing-credentials')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('prefers the USD balance_info when present', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse(USD_BALANCE))

    const result = await fetchDeepSeekRateLimits({ env: { DEEPSEEK_API_KEY: 'sk-test' } })

    expect(result.status).toBe('ok')
    expect(result.monthly?.usedPercent).toBe(0)
    expect(result.monthly?.windowMinutes).toBe(43_200)
    expect(result.monthly?.resetsAt).toBeNull()
    expect(result.monthly?.resetDescription).toBe('USD 110.00')
    expect(result.planType).toBe('USD')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
    expect(result.usageMetadata?.source).toBe('cli')
    expect(result.usageMetadata?.authProvenance).toContain('USD 110.00')

    expect(netFetchMock).toHaveBeenCalledWith(
      'https://api.deepseek.com/user/balance',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-test',
          Accept: 'application/json'
        })
      })
    )
  })

  it('falls back to the first balance_info when USD is absent', async () => {
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        is_available: true,
        balance_infos: [
          {
            currency: 'CNY',
            total_balance: '88.50',
            granted_balance: '0',
            topped_up_balance: '88.50'
          }
        ]
      })
    )

    const result = await fetchDeepSeekRateLimits({ env: { DEEPSEEK_API_KEY: 'sk-cny' } })
    expect(result.status).toBe('ok')
    expect(result.monthly?.resetDescription).toBe('CNY 88.50')
    expect(result.planType).toBe('CNY')
    expect(result.monthly?.usedPercent).toBe(0)
  })

  it('reports 100% used when balance is unavailable or non-positive', async () => {
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        is_available: false,
        balance_infos: [{ currency: 'USD', total_balance: '5.00' }]
      })
    )
    const unavailable = await fetchDeepSeekRateLimits({ env: { DEEPSEEK_API_KEY: 'sk' } })
    expect(unavailable.status).toBe('ok')
    expect(unavailable.monthly?.usedPercent).toBe(100)

    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        is_available: true,
        balance_infos: [{ currency: 'USD', total_balance: '0.00' }]
      })
    )
    const zero = await fetchDeepSeekRateLimits({ env: { DEEPSEEK_API_KEY: 'sk' } })
    expect(zero.status).toBe('ok')
    expect(zero.monthly?.usedPercent).toBe(100)
  })

  it('returns error on 401', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse({}, 401))
    const result = await fetchDeepSeekRateLimits({ env: { DEEPSEEK_API_KEY: 'sk-bad' } })
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/unauthorized/i)
    expect(result.usageMetadata?.failureKind).toBe('stale-token')
  })

  it('returns error when the response body is not JSON', async () => {
    netFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token')
      }
    } as unknown as Response)

    const result = await fetchDeepSeekRateLimits({ env: { DEEPSEEK_API_KEY: 'sk' } })
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/valid JSON/i)
    expect(result.usageMetadata?.failureKind).toBe('parse')
  })

  it('returns error when balance_infos is missing', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse({ is_available: true }))
    const result = await fetchDeepSeekRateLimits({ env: { DEEPSEEK_API_KEY: 'sk' } })
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/balance_infos/i)
  })

  it('returns error on network failure', async () => {
    netFetchMock.mockRejectedValueOnce(new Error('network down'))
    const result = await fetchDeepSeekRateLimits({ env: { DEEPSEEK_API_KEY: 'sk' } })
    expect(result.status).toBe('error')
    expect(result.error).toBe('network down')
    expect(result.usageMetadata?.failureKind).toBe('network')
  })
})
