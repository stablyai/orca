import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GeminiCredentials } from './gemini-oauth-sources'

const netFetchMock = vi.hoisted(() => vi.fn())
const oauthState = vi.hoisted<{
  credentials: GeminiCredentials | null
  readError: Error | null
  refreshAccessToken: string | null
}>(() => ({
  credentials: null,
  readError: null,
  refreshAccessToken: 'refreshed-token'
}))

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

const keyringState = vi.hoisted<{ credentials: GeminiCredentials | null }>(() => ({
  credentials: null
}))

vi.mock('./gemini-oauth-sources', () => ({
  readGeminiCredentials: async () => {
    if (oauthState.readError) {
      throw oauthState.readError
    }
    return oauthState.credentials
  },
  tryRefreshTokenFromBundle: async () =>
    oauthState.refreshAccessToken
      ? { accessToken: oauthState.refreshAccessToken, newRefreshToken: null }
      : null
}))

vi.mock('./antigravity-keyring', () => ({
  readAntigravityKeyringCredentials: () => keyringState.credentials
}))

import { fetchAntigravityRateLimits } from './antigravity-fetcher'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response
}

const PROJECT_RESPONSE = { cloudaicompanionProject: 'projects/test-123' }

// Shape captured from POST cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels.
const MODELS_RESPONSE = {
  models: {
    'gemini-3.1-pro': {
      quotaInfo: { remainingFraction: 0.25, resetTime: '2026-07-10T08:00:00Z' }
    },
    'gemini-3.1-flash': {
      quotaInfo: { remainingFraction: 0.9, resetTime: '2026-07-10T08:00:00Z' }
    }
  }
}

const QUOTA_RESPONSE = {
  buckets: [
    { modelId: 'gemini-3.1-pro', remainingFraction: 0.4, resetTime: '2026-07-10T09:00:00Z' }
  ]
}

function freshCredentials(): GeminiCredentials {
  return {
    access_token: 'tok-abc',
    refresh_token: 'refresh-abc',
    expiry_date: Date.now() + 60 * 60 * 1000
  }
}

function routeByUrl(handlers: { models?: Response; quota?: Response; project?: Response }): void {
  netFetchMock.mockImplementation((url: string) => {
    if (url.includes('loadCodeAssist')) {
      return Promise.resolve(handlers.project ?? jsonResponse(PROJECT_RESPONSE))
    }
    if (url.includes('fetchAvailableModels')) {
      return Promise.resolve(handlers.models ?? jsonResponse(MODELS_RESPONSE))
    }
    if (url.includes('retrieveUserQuota')) {
      return Promise.resolve(handlers.quota ?? jsonResponse(QUOTA_RESPONSE))
    }
    return Promise.resolve(jsonResponse({}, 404))
  })
}

describe('fetchAntigravityRateLimits', () => {
  beforeEach(() => {
    netFetchMock.mockReset()
    oauthState.credentials = null
    oauthState.readError = null
    oauthState.refreshAccessToken = 'refreshed-token'
    keyringState.credentials = null
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('reports unavailable when no ~/.gemini credentials exist', async () => {
    oauthState.credentials = null
    const result = await fetchAntigravityRateLimits()
    expect(result.provider).toBe('antigravity')
    expect(result.status).toBe('unavailable')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('falls back to the OS keyring when no ~/.gemini file exists', async () => {
    oauthState.credentials = null
    keyringState.credentials = freshCredentials()
    routeByUrl({})
    const result = await fetchAntigravityRateLimits()
    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(75)
  })

  it('maps fetchAvailableModels quota into buckets with a most-constrained session', async () => {
    oauthState.credentials = freshCredentials()
    routeByUrl({})
    const result = await fetchAntigravityRateLimits()
    expect(result.status).toBe('ok')
    expect(result.buckets && result.buckets.length).toBeGreaterThan(0)
    // 0.25 remaining => 75% used is the most constrained model.
    expect(result.session?.usedPercent).toBe(75)
    expect(result.session?.resetsAt).toBe(new Date('2026-07-10T08:00:00Z').getTime())
  })

  it('groups models into Gemini and Claude/GPT families and drops internal buckets', async () => {
    oauthState.credentials = freshCredentials()
    routeByUrl({
      models: jsonResponse({
        models: {
          'gemini-2.5-pro': {
            quotaInfo: { remainingFraction: 0.2, resetTime: '2026-07-10T08:00:00Z' }
          },
          'gemini-2.5-flash': {
            quotaInfo: { remainingFraction: 0.9, resetTime: '2026-07-10T08:00:00Z' }
          },
          'claude-sonnet-4-6': {
            quotaInfo: { remainingFraction: 0.5, resetTime: '2026-07-10T09:00:00Z' }
          },
          'gpt-oss-120b': {
            quotaInfo: { remainingFraction: 0.7, resetTime: '2026-07-10T09:00:00Z' }
          },
          tab_flash_lite_preview: {
            quotaInfo: { remainingFraction: 1, resetTime: '2026-07-10T08:00:00Z' }
          },
          chat_20706: { quotaInfo: { remainingFraction: 1, resetTime: '2026-07-10T08:00:00Z' } }
        }
      })
    })
    const result = await fetchAntigravityRateLimits()
    expect(result.status).toBe('ok')
    // Two families; internal buckets dropped.
    expect(result.buckets?.map((b) => b.name)).toEqual(['Gemini Models', 'Claude and GPT models'])
    // Each family shows its most-constrained model: Gemini pro 80%, Claude/GPT 50%.
    expect(result.buckets?.map((b) => b.usedPercent)).toEqual([80, 50])
  })

  it('falls back to retrieveUserQuota when fetchAvailableModels is empty', async () => {
    oauthState.credentials = freshCredentials()
    routeByUrl({ models: jsonResponse({ models: {} }) })
    const result = await fetchAntigravityRateLimits()
    expect(result.status).toBe('ok')
    // 0.4 remaining => 60% used from the quota bucket.
    expect(result.session?.usedPercent).toBe(60)
  })

  it('refreshes the token in memory and retries once on 401', async () => {
    oauthState.credentials = freshCredentials()
    let modelsCalls = 0
    netFetchMock.mockImplementation((url: string) => {
      if (url.includes('loadCodeAssist')) {
        return Promise.resolve(jsonResponse(PROJECT_RESPONSE))
      }
      if (url.includes('fetchAvailableModels')) {
        modelsCalls += 1
        return Promise.resolve(
          modelsCalls === 1 ? jsonResponse({}, 401) : jsonResponse(MODELS_RESPONSE)
        )
      }
      return Promise.resolve(jsonResponse({}, 404))
    })
    const result = await fetchAntigravityRateLimits()
    expect(result.status).toBe('ok')
    expect(modelsCalls).toBe(2)
  })

  it('errors when the token is expired and cannot be refreshed', async () => {
    oauthState.credentials = {
      access_token: 'stale',
      refresh_token: 'refresh-abc',
      expiry_date: Date.now() - 1000
    }
    oauthState.refreshAccessToken = null
    const result = await fetchAntigravityRateLimits()
    expect(result.status).toBe('error')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('errors when the quota response has no usable buckets', async () => {
    oauthState.credentials = freshCredentials()
    routeByUrl({ models: jsonResponse({ models: {} }), quota: jsonResponse({ buckets: [] }) })
    const result = await fetchAntigravityRateLimits()
    expect(result.status).toBe('error')
  })
})
