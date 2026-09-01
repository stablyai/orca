import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { netFetchMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn()
}))

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

vi.mock('./antigravity-credentials', () => ({
  readAntigravityCredentials: vi.fn(),
  hasAntigravityAuthConfigured: (result: { status: string }) => result.status === 'ok'
}))

import { fetchAntigravityRateLimits } from './antigravity-usage-fetcher'
import { readAntigravityCredentials } from './antigravity-credentials'

describe('fetchAntigravityRateLimits', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    netFetchMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns unavailable when credentials are missing', async () => {
    vi.mocked(readAntigravityCredentials).mockResolvedValue({ status: 'missing' })
    const result = await fetchAntigravityRateLimits()
    expect(result.status).toBe('unavailable')
    expect(result.error).toMatch(/sign in/i)
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('returns unavailable on non-Windows without probing the API', async () => {
    const result = await fetchAntigravityRateLimits({
      credentialsReadResult: { status: 'unsupported' }
    })
    expect(result.status).toBe('unavailable')
    expect(result.error).toMatch(/Windows/i)
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('posts ideType ANTIGRAVITY and uses retrieveUserQuotaSummary', async () => {
    netFetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('loadCodeAssist')) {
        return {
          ok: true,
          json: async () => ({ cloudaicompanionProject: 'projects/my-proj' })
        }
      }
      if (String(url).includes('retrieveUserQuotaSummary')) {
        return {
          ok: true,
          json: async () => ({
            groups: [
              {
                displayName: 'Claude',
                buckets: [
                  {
                    bucketId: 'claude',
                    window: '5h',
                    remainingFraction: 0.5,
                    resetTime: '2026-07-18T12:00:00Z'
                  },
                  {
                    bucketId: 'claude',
                    window: 'weekly',
                    remainingFraction: 0.8,
                    resetTime: '2026-07-20T00:00:00Z'
                  }
                ]
              },
              {
                displayName: 'Gemini',
                buckets: [
                  {
                    bucketId: 'gemini',
                    window: '5h',
                    remainingFraction: 0.25,
                    resetTime: '2026-07-18T13:00:00Z'
                  },
                  {
                    bucketId: 'gemini',
                    window: 'weekly',
                    remainingFraction: 0.9,
                    resetTime: '2026-07-21T00:00:00Z'
                  }
                ]
              }
            ]
          })
        }
      }
      if (String(url).includes('fetchAvailableModels')) {
        return { ok: true, json: async () => ({ models: {} }) }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    })

    const result = await fetchAntigravityRateLimits({
      credentialsReadResult: {
        status: 'ok',
        credentials: {
          accessToken: 'ya29.test',
          refreshToken: '1//refresh'
        }
      }
    })

    expect(result.status).toBe('ok')
    expect(result.buckets?.map((b) => b.name)).toEqual(['Claude', 'Claude W', 'Gemini', 'Gemini W'])
    expect(result.buckets?.find((b) => b.name === 'Claude')?.usedPercent).toBe(50)
    expect(result.buckets?.find((b) => b.name === 'Gemini')?.usedPercent).toBe(75)

    const loadCall = netFetchMock.mock.calls.find((c) => String(c[0]).includes('loadCodeAssist'))
    expect(loadCall).toBeDefined()
    const loadBody = JSON.parse((loadCall![1] as RequestInit).body as string)
    expect(loadBody).toEqual({ metadata: { ideType: 'ANTIGRAVITY' } })

    const summaryCall = netFetchMock.mock.calls.find((c) =>
      String(c[0]).includes('retrieveUserQuotaSummary')
    )
    expect(summaryCall).toBeDefined()
    expect(String(summaryCall![0])).toMatch(/cloudcode-pa/)
  })

  it('treats a quota-summary 401 as unauthorized even when models succeed', async () => {
    vi.stubEnv('ANTIGRAVITY_CLIENT_ID', '')
    vi.stubEnv('ANTIGRAVITY_CLIENT_SECRET', '')
    netFetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('loadCodeAssist')) {
        return { ok: true, json: async () => ({}) }
      }
      if (String(url).includes('retrieveUserQuotaSummary')) {
        return { ok: false, status: 401 }
      }
      if (String(url).includes('fetchAvailableModels')) {
        return { ok: true, json: async () => ({ models: {} }) }
      }
      return { ok: false, status: 404 }
    })

    const result = await fetchAntigravityRateLimits({
      credentialsReadResult: {
        status: 'ok',
        credentials: { accessToken: 'stale', refreshToken: 'refresh' }
      }
    })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('stale-token')
  })

  it('keeps valid summary quota when the optional models fallback fails', async () => {
    netFetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('loadCodeAssist')) {
        return { ok: true, json: async () => ({}) }
      }
      if (String(url).includes('retrieveUserQuotaSummary')) {
        return {
          ok: true,
          json: async () => ({
            groups: [
              {
                displayName: 'Claude',
                buckets: [{ window: '5h', remainingFraction: 0.6 }]
              }
            ]
          })
        }
      }
      return { ok: false, status: 503 }
    })

    const result = await fetchAntigravityRateLimits({
      credentialsReadResult: {
        status: 'ok',
        credentials: { accessToken: 'token', refreshToken: null }
      }
    })

    expect(result.status).toBe('ok')
    expect(result.buckets).toEqual([
      expect.objectContaining({ name: 'Claude', usedPercent: 40, windowMinutes: 300 })
    ])
  })

  it('aborts in-flight quota requests', async () => {
    const controller = new AbortController()
    netFetchMock.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    })

    const fetchPromise = fetchAntigravityRateLimits({
      credentialsReadResult: {
        status: 'ok',
        credentials: { accessToken: 'token', refreshToken: null }
      },
      signal: controller.signal
    })
    controller.abort(new Error('stopped'))

    await expect(fetchPromise).rejects.toThrow('stopped')
  })
})
