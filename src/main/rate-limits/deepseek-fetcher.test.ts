import { afterEach, describe, expect, it, vi } from 'vitest'
import { setMainHttpClient } from '../network/http-client'
import { DEEPSEEK_FIXTURE_BALANCE, SYNTHETIC_DEEPSEEK_KEY } from '../deepseek/deepseek-test-fixture'
import { DEEPSEEK_BALANCE_URL, fetchDeepSeekBalance } from './deepseek-fetcher'

afterEach(() => {
  setMainHttpClient(null)
  vi.restoreAllMocks()
})

describe('DeepSeek official balance contract', () => {
  it('preserves both currencies and exact string precision without quota windows', async () => {
    const fetch = vi.fn(async () => Response.json(DEEPSEEK_FIXTURE_BALANCE))
    setMainHttpClient({ fetch, proxySession: () => null })
    const result = await fetchDeepSeekBalance(SYNTHETIC_DEEPSEEK_KEY)
    expect(result).toMatchObject({
      status: 'ok',
      balance: DEEPSEEK_FIXTURE_BALANCE,
      session: null,
      weekly: null,
      monthly: null
    })
    expect(fetch).toHaveBeenCalledWith(
      DEEPSEEK_BALANCE_URL,
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        headers: { Authorization: `Bearer ${SYNTHETIC_DEEPSEEK_KEY}`, Accept: 'application/json' }
      })
    )
    expect(JSON.stringify(result)).not.toContain(SYNTHETIC_DEEPSEEK_KEY)
  })

  it('keeps is_available=false separate from the actual amounts', async () => {
    setMainHttpClient({
      fetch: async () => Response.json({ ...DEEPSEEK_FIXTURE_BALANCE, is_available: false }),
      proxySession: () => null
    })
    expect(await fetchDeepSeekBalance(SYNTHETIC_DEEPSEEK_KEY)).toMatchObject({
      status: 'ok',
      balance: { is_available: false, balance_infos: DEEPSEEK_FIXTURE_BALANCE.balance_infos }
    })
  })

  it.each([401, 403, 429, 500, 302])(
    'sanitizes HTTP %s failures without treating them as zero balance',
    async (status) => {
      setMainHttpClient({
        fetch: async () => new Response(SYNTHETIC_DEEPSEEK_KEY, { status }),
        proxySession: () => null
      })
      const result = await fetchDeepSeekBalance(SYNTHETIC_DEEPSEEK_KEY)
      expect(result).toMatchObject({ status: 'error', balance: null, monthly: null })
      expect(result.usageMetadata?.failureKind).toBe(
        status === 401 || status === 403
          ? 'stale-token'
          : status === 429
            ? 'rate-limited'
            : 'server'
      )
      expect(JSON.stringify(result)).not.toContain(SYNTHETIC_DEEPSEEK_KEY)
    }
  )

  it.each([
    {},
    { is_available: true, balance_infos: [] },
    { is_available: 'true', balance_infos: [] },
    {
      is_available: true,
      balance_infos: [
        { currency: 'EUR', total_balance: '1', granted_balance: '0', topped_up_balance: '1' }
      ]
    },
    ...['NaN', 'Infinity', '1e4', '$1', '', 12].map((amount) => ({
      is_available: true,
      balance_infos: [
        { currency: 'USD', total_balance: amount, granted_balance: '0', topped_up_balance: '1' }
      ]
    })),
    {
      is_available: true,
      balance_infos: [
        DEEPSEEK_FIXTURE_BALANCE.balance_infos[0],
        DEEPSEEK_FIXTURE_BALANCE.balance_infos[0]
      ]
    }
  ])('rejects malformed balance payload %#', async (payload) => {
    setMainHttpClient({ fetch: async () => Response.json(payload), proxySession: () => null })
    expect(await fetchDeepSeekBalance(SYNTHETIC_DEEPSEEK_KEY)).toMatchObject({
      status: 'error',
      balance: null,
      usageMetadata: { failureKind: 'parse' }
    })
  })

  it('sanitizes transport exceptions and skips HTTP when no protected key is present', async () => {
    const fetch = vi.fn(async (): Promise<Response> => {
      throw new Error(SYNTHETIC_DEEPSEEK_KEY)
    })
    setMainHttpClient({ fetch, proxySession: () => null })
    expect(await fetchDeepSeekBalance(null)).toMatchObject({ status: 'unavailable', balance: null })
    expect(fetch).not.toHaveBeenCalled()
    const result = await fetchDeepSeekBalance(SYNTHETIC_DEEPSEEK_KEY)
    expect(result.usageMetadata?.failureKind).toBe('network')
    expect(JSON.stringify(result)).not.toContain(SYNTHETIC_DEEPSEEK_KEY)
  })

  it('bounds a successful response body', async () => {
    setMainHttpClient({
      fetch: async () => new Response(' '.repeat(32_769)),
      proxySession: () => null
    })
    expect(await fetchDeepSeekBalance(SYNTHETIC_DEEPSEEK_KEY)).toMatchObject({
      status: 'error',
      balance: null
    })
  })
})
