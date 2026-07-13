import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const netFetchMock = vi.hoisted(() => vi.fn())
const authState = vi.hoisted<{
  file: string | null
  readError: Error | null
}>(() => ({ file: null, readError: null }))

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

vi.mock('node:fs', () => ({
  existsSync: () => authState.file !== null,
  readFileSync: () => {
    if (authState.readError) {
      throw authState.readError
    }
    if (authState.file === null) {
      throw new Error('ENOENT')
    }
    return authState.file
  }
}))

vi.mock('node:os', () => ({ homedir: () => '/home/test' }))

import { fetchGrokRateLimits } from './grok-fetcher'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response
}

const BILLING_RESPONSE = {
  config: {
    creditUsagePercent: 42,
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2026-06-30T18:36:14.268512+00:00',
      end: '2026-07-07T18:36:14.268512+00:00'
    },
    subscriptionTier: 'SuperGrok',
    isUnifiedBillingUser: true
  }
}

function freshAuthJson(): string {
  return JSON.stringify({
    'https://auth.x.ai::client': {
      key: 'access-token',
      user_id: 'user-1',
      email: 'dev@example.com',
      expires_at: '2099-01-01T00:00:00.000Z'
    }
  })
}

describe('fetchGrokRateLimits', () => {
  beforeEach(() => {
    netFetchMock.mockReset()
    authState.file = null
    authState.readError = null
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns unavailable when not signed in', async () => {
    const result = await fetchGrokRateLimits()
    expect(result.provider).toBe('grok')
    expect(result.status).toBe('unavailable')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('maps weekly credit usage from billing config', async () => {
    authState.file = freshAuthJson()
    netFetchMock.mockResolvedValueOnce(jsonResponse(BILLING_RESPONSE))

    const result = await fetchGrokRateLimits()
    expect(result.status).toBe('ok')
    expect(result.weekly?.usedPercent).toBe(42)
    expect(result.weekly?.windowMinutes).toBe(10_080)
    expect(result.usageMetadata?.source).toBe('oauth')
    expect(result.usageMetadata?.authProvenance).toContain('SuperGrok')

    expect(netFetchMock).toHaveBeenCalledWith(
      'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer access-token',
          'X-XAI-Token-Auth': 'xai-grok-cli',
          'x-userid': 'user-1'
        })
      })
    )
    // Why: primary response already has creditUsagePercent — no fallback fetch.
    expect(netFetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns unavailable when not signed in even if a token-less auth file exists', async () => {
    authState.file = JSON.stringify({})
    const result = await fetchGrokRateLimits()
    expect(result.status).toBe('unavailable')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('treats unified weekly config without counters as 0% used after fallback', async () => {
    authState.file = freshAuthJson()
    netFetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          config: {
            currentPeriod: {
              type: 'USAGE_PERIOD_TYPE_WEEKLY',
              start: '2026-07-11T10:28:18.446096+00:00',
              end: '2026-07-18T10:28:18.446096+00:00'
            },
            isUnifiedBillingUser: true,
            prepaidBalance: { val: 0 }
          },
          subscriptionTier: 'SuperGrok'
        })
      )
      // Fallback also has no counters — still show 0% with weekly reset.
      .mockResolvedValueOnce(jsonResponse({ config: { prepaidBalance: { val: 0 } } }))

    const result = await fetchGrokRateLimits()
    expect(result.status).toBe('ok')
    expect(result.weekly?.usedPercent).toBe(0)
    expect(result.weekly?.resetsAt).toBe(Date.parse('2026-07-18T10:28:18.446096+00:00'))
    expect(result.usageMetadata?.authProvenance).toContain('SuperGrok')
    expect(netFetchMock).toHaveBeenCalledTimes(2)
  })

  it('merges weekly period from credits with used/limit from default billing', async () => {
    authState.file = freshAuthJson()
    netFetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          config: {
            currentPeriod: {
              type: 'USAGE_PERIOD_TYPE_WEEKLY',
              end: '2026-07-18T10:28:18.446096+00:00'
            },
            isUnifiedBillingUser: true
          },
          subscriptionTier: 'SuperGrok'
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          config: {
            monthlyLimit: { val: 15000 },
            used: { val: 1500 },
            billingPeriodEnd: '2026-08-01T00:00:00+00:00'
          }
        })
      )

    const result = await fetchGrokRateLimits()
    expect(result.status).toBe('ok')
    expect(result.weekly?.usedPercent).toBe(10)
    // Prefer weekly reset from format=credits over monthly billing end.
    expect(result.weekly?.resetsAt).toBe(Date.parse('2026-07-18T10:28:18.446096+00:00'))
    expect(result.usageMetadata?.authProvenance).toContain('SuperGrok')
  })

  it('maps productUsage percents when creditUsagePercent is missing', async () => {
    authState.file = freshAuthJson()
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        config: {
          currentPeriod: {
            type: 'USAGE_PERIOD_TYPE_WEEKLY',
            end: '2026-07-18T10:28:18.446096+00:00'
          },
          productUsage: [
            { product: 'GrokBuild', usagePercent: 3 },
            { product: 'Chat', usagePercent: 2 }
          ],
          isUnifiedBillingUser: true
        }
      })
    )

    const result = await fetchGrokRateLimits()
    expect(result.status).toBe('ok')
    expect(result.weekly?.usedPercent).toBe(5)
  })

  it('falls back to default billing used/monthlyLimit when credits omit usage', async () => {
    authState.file = freshAuthJson()
    // First response: non-unified shell with no usable percent — forces fallback path.
    netFetchMock
      .mockResolvedValueOnce(jsonResponse({ config: { subscriptionTier: 'Enterprise' } }))
      .mockResolvedValueOnce(
        jsonResponse({
          config: {
            monthlyLimit: { val: 15000 },
            used: { val: 1500 },
            billingPeriodEnd: '2026-08-01T00:00:00+00:00'
          }
        })
      )

    const result = await fetchGrokRateLimits()
    expect(result.status).toBe('ok')
    expect(result.weekly?.usedPercent).toBe(10)
    expect(netFetchMock).toHaveBeenCalledTimes(2)
    expect(netFetchMock).toHaveBeenNthCalledWith(
      2,
      'https://cli-chat-proxy.grok.com/v1/billing',
      expect.anything()
    )
  })

  it('returns unavailable when billing has no credit usage and no fallback data', async () => {
    authState.file = freshAuthJson()
    netFetchMock
      .mockResolvedValueOnce(jsonResponse({ config: { subscriptionTier: 'Enterprise' } }))
      .mockResolvedValueOnce(jsonResponse({ config: { subscriptionTier: 'Enterprise' } }))

    const result = await fetchGrokRateLimits()
    expect(result.status).toBe('unavailable')
    expect(result.weekly).toBeNull()
  })

  it('returns unavailable when billing response has no config', async () => {
    authState.file = freshAuthJson()
    netFetchMock
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({}))

    const result = await fetchGrokRateLimits()
    expect(result.status).toBe('unavailable')
  })

  it('aborts the billing request when the caller aborts', async () => {
    authState.file = freshAuthJson()
    const controller = new AbortController()
    let requestSignal: AbortSignal | undefined
    netFetchMock.mockImplementationOnce((_url, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal
      return new Promise((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true
        })
      })
    })

    const resultPromise = fetchGrokRateLimits({ signal: controller.signal })
    await Promise.resolve()

    expect(requestSignal?.aborted).toBe(false)
    controller.abort()
    expect(requestSignal?.aborted).toBe(true)

    const result = await resultPromise
    expect(result.status).toBe('error')
    expect(result.error).toBe('aborted')
  })

  it('returns error when the session token is expired', async () => {
    authState.file = JSON.stringify({
      'https://auth.x.ai::client': {
        key: 'stale',
        expires_at: '2000-01-01T00:00:00.000Z'
      }
    })
    const result = await fetchGrokRateLimits()
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/expired/i)
    expect(netFetchMock).not.toHaveBeenCalled()
  })
})
