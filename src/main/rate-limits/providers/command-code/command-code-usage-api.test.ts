import { afterEach, describe, expect, it } from 'vitest'
import { setMainHttpClient } from '../../../network/http-client'
import { COMMAND_CODE_CREDITS_PATH, fetchCommandCodeRateLimits } from './command-code-usage-api'

// Fixed far-future reset so the fixture never depends on the wall clock.
const FIXED_RESET_MS = Date.UTC(2099, 0, 1)
const KEY = 'cc-test-key-0000'

function routeBy(handler: (url: string) => Response): { urls: string[]; headers: HeadersInit[] } {
  const seen: { urls: string[]; headers: HeadersInit[] } = { urls: [], headers: [] }
  setMainHttpClient({
    fetch: async (url: string, init?: RequestInit) => {
      seen.urls.push(url)
      seen.headers.push(init?.headers ?? {})
      return handler(url)
    },
    proxySession: () => null
  })
  return seen
}

describe('fetchCommandCodeRateLimits', () => {
  afterEach(() => setMainHttpClient(null))

  it('sends the key only as a bearer header and never echoes it in errors', async () => {
    const seen = routeBy(() => new Response('{}', { status: 500 }))
    const result = await fetchCommandCodeRateLimits({ apiKey: KEY })
    expect(seen.urls.length).toBeGreaterThan(0)
    for (const headers of seen.headers) {
      expect(headers).toEqual({ Authorization: `Bearer ${KEY}`, Accept: 'application/json' })
    }
    expect(JSON.stringify(result)).not.toContain(KEY)
  })

  it('fails without a fallback source when the key is rejected', async () => {
    const seen = routeBy(() => new Response('{}', { status: 401 }))
    const result = await fetchCommandCodeRateLimits({ apiKey: KEY })
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('missing-credentials')
    expect(seen.urls.every((url) => url.includes('/alpha/billing/'))).toBe(true)
  })

  it('reads session and weekly windows plus credit balance from the billing routes', async () => {
    const credits = {
      credits: { monthlyCredits: 10, purchasedCredits: 5, freeCredits: 2 },
      windowLimits: {
        fiveHour: { used: 1.25, cap: 14, exceeded: false, resetAt: FIXED_RESET_MS },
        weekly: { used: 33.75, cap: 35, exceeded: false, resetAt: FIXED_RESET_MS }
      }
    }
    routeBy((url) =>
      url.endsWith(COMMAND_CODE_CREDITS_PATH)
        ? new Response(JSON.stringify(credits), { status: 200 })
        : new Response(JSON.stringify({ success: true, data: { status: 'active' } }), {
            status: 200
          })
    )
    const result = await fetchCommandCodeRateLimits({ apiKey: KEY })
    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe((1.25 / 14) * 100)
    expect(result.weekly?.usedPercent).toBe((33.75 / 35) * 100)
    expect(result.extraUsage).toMatchObject({ balance: 17 })
    expect(result.planType).toBe('active')
  })

  it('reports a rejected key when the subscriptions route returns 401, even if credits is 404', async () => {
    routeBy((url) =>
      url.endsWith(COMMAND_CODE_CREDITS_PATH)
        ? new Response('{}', { status: 404 })
        : new Response('{}', { status: 401 })
    )
    const result = await fetchCommandCodeRateLimits({ apiKey: KEY })
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('missing-credentials')
    expect(result.error).toBe(
      'Command Code rejected the saved API key (subscriptions returned HTTP 401)'
    )
  })
})
