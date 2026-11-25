import { afterEach, describe, expect, it } from 'vitest'
import { setMainHttpClient } from '../../../network/http-client'
import { COMMAND_CODE_CREDITS_PATH, fetchCommandCodeRateLimits } from './command-code-usage-api'

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

  it('reads a monthly window from the subscriptions route', async () => {
    routeBy((url) =>
      url.endsWith(COMMAND_CODE_CREDITS_PATH)
        ? new Response(JSON.stringify({ balance: 2 }), { status: 200 })
        : new Response(JSON.stringify({ used: 10, limit: 40 }), { status: 200 })
    )
    const result = await fetchCommandCodeRateLimits({ apiKey: KEY })
    expect(result.status).toBe('ok')
    expect(result.monthly?.usedPercent).toBe(25)
    expect(result.extraUsage).toMatchObject({ balance: 2 })
  })
})
