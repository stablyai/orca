import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type NetFetch = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
}>

const netState: { fetch: NetFetch | null } = { fetch: null }

vi.mock('electron', () => ({
  net: {
    get fetch() {
      return netState.fetch!
    }
  }
}))

import { fetchFactoryRateLimits } from './factory-fetcher'
import type { FactoryApiKeyReadResult } from './factory-auth'

function billingPayload(standard: unknown, core?: unknown): unknown {
  return {
    usesTokenRateLimitsBilling: true,
    limits: { standard, ...(core !== undefined ? { core } : {}) }
  }
}

const okKey: FactoryApiKeyReadResult = { status: 'ok', apiKey: 'fk-test', source: 'orca' }

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('fetchFactoryRateLimits', () => {
  it('returns unavailable without fetching when no key is configured', async () => {
    const fetchMock = vi.fn()
    netState.fetch = fetchMock as unknown as NetFetch
    const result = await fetchFactoryRateLimits({
      apiKeyReadResult: { status: 'missing' }
    })
    expect(result.status).toBe('unavailable')
    expect(result.error).toBe('Factory API key not configured')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.usageMetadata?.failureKind).toBe('missing-credentials')
  })

  it('maps standard fiveHour to the session window with secondsRemaining reset', async () => {
    netState.fetch = vi.fn(async (url: string) => {
      if (url.includes('/api/app/auth/me')) {
        throw new Error('auth-me should not block')
      }
      return {
        ok: true,
        status: 200,
        json: async () =>
          billingPayload({
            fiveHour: { usedPercent: 12.5, secondsRemaining: 3600 },
            weekly: { usedPercent: 30 },
            monthly: { usedPercent: 60 }
          })
      }
    }) as unknown as NetFetch
    const result = await fetchFactoryRateLimits({ apiKeyReadResult: okKey })
    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(12.5)
    expect(result.session?.windowMinutes).toBe(300)
    expect(result.session?.resetsAt).toBeGreaterThan(Date.now() + 3_500_000)
    expect(result.weekly?.usedPercent).toBe(30)
    expect(result.monthly?.usedPercent).toBe(60)
    expect(result.usageMetadata?.source).toBe('web')
  })

  it('falls back to the core pool when standard has no windows', async () => {
    netState.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () =>
        billingPayload({ fiveHour: { usedPercent: Number.NaN } }, { weekly: { usedPercent: 40 } })
    })) as unknown as NetFetch
    const result = await fetchFactoryRateLimits({ apiKeyReadResult: okKey })
    expect(result.status).toBe('ok')
    expect(result.weekly?.usedPercent).toBe(40)
    expect(result.session).toBeNull()
  })

  it('maps 401 to a stale-token error', async () => {
    netState.fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({})
    })) as unknown as NetFetch
    const result = await fetchFactoryRateLimits({ apiKeyReadResult: okKey })
    expect(result.status).toBe('error')
    expect(result.error).toBe('Factory usage request unauthorized (HTTP 401)')
    expect(result.usageMetadata?.failureKind).toBe('stale-token')
  })

  it('uses the legacy usage endpoint when billing has no windows', async () => {
    netState.fetch = vi.fn(async (url: string) => {
      if (url.includes('/api/billing/limits')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ usesTokenRateLimitsBilling: true, limits: {} })
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ usage: { standard: { usedRatio: 0.25 } } })
      }
    }) as unknown as NetFetch
    const result = await fetchFactoryRateLimits({ apiKeyReadResult: okKey })
    expect(result.status).toBe('ok')
    expect(result.weekly?.usedPercent).toBe(25)
    expect(result.session).toBeNull()
  })

  it('reports usage-unavailable when billing and legacy both yield nothing', async () => {
    netState.fetch = vi.fn(async (url: string) => {
      if (url.includes('/api/billing/limits')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ usesTokenRateLimitsBilling: true, limits: {} })
        }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }) as unknown as NetFetch
    const result = await fetchFactoryRateLimits({ apiKeyReadResult: okKey })
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('usage-unavailable')
  })
})
