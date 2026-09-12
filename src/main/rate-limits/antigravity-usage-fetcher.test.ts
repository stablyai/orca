import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authJsonGoogle, makeResponse } from './gemini-usage-fetcher.test-fixtures'
import type * as AntigravityOauthSourcesModule from './antigravity-oauth-sources'

const { readFileMock, extractCredsMock, netFetchMock, keychainMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  extractCredsMock: vi.fn(),
  netFetchMock: vi.fn(),
  keychainMock: vi.fn()
}))

vi.mock('./gemini-cli-oauth-extractor', () => ({
  extractOAuthClientCredentials: extractCredsMock
}))

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('electron', () => ({ net: { fetch: netFetchMock } }))

// Why: the real keychain reader shells out to /usr/bin/security; unit tests
// must not touch the host keychain (or pick up the developer's live token).
vi.mock('./antigravity-oauth-sources', async (importOriginal) => {
  const actual = await importOriginal<AntigravityOauthSourcesModule>()
  return {
    ...actual,
    readAntigravityKeychainCredentials: keychainMock
  }
})

import { fetchAntigravityRateLimits } from './antigravity-usage-fetcher'

describe('fetchAntigravityRateLimits', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-24T12:00:00.000Z'))
    readFileMock.mockReset()
    extractCredsMock.mockReset()
    netFetchMock.mockReset()
    keychainMock.mockReset().mockResolvedValue(null)
    netFetchMock.mockImplementation((url: string) => {
      if (url.includes('loadCodeAssist')) {
        return Promise.resolve(makeResponse({ cloudaicompanionProject: 'proj-123' }))
      }
      if (url.includes('token')) {
        return Promise.resolve(makeResponse({ access_token: 'new-token', expires_in: 3600 }))
      }
      return Promise.resolve(makeResponse({ error: `Unhandled fetch to ${url}` }, 500))
    })
    extractCredsMock.mockResolvedValue(null)
    readFileMock.mockRejectedValue({ code: 'ENOENT' })
  })

  const setupAuthJsonValid = () => {
    readFileMock.mockImplementation(async (p: string) => {
      if (p.includes('auth.json')) {
        return JSON.stringify(authJsonGoogle)
      }
      throw { code: 'ENOENT' }
    })
  }

  it('returns unavailable when disabled in settings', async () => {
    const result = await fetchAntigravityRateLimits(false)
    expect(result.status).toBe('unavailable')
    expect(result.provider).toBe('antigravity')
  })

  it('returns unavailable when no credentials exist', async () => {
    const result = await fetchAntigravityRateLimits(true)
    expect(result.status).toBe('unavailable')
    expect(result.provider).toBe('antigravity')
  })

  const modelsResponse = {
    models: {
      'claude-sonnet-4-6': {
        displayName: 'Claude Sonnet 4.6',
        quotaInfo: { remainingFraction: 0.75, resetTime: '2026-04-24T13:00:00.000Z' }
      },
      'gpt-oss-120b-medium': {
        displayName: 'GPT-OSS 120B',
        quotaInfo: { remainingFraction: 0.9, resetTime: '2026-04-24T14:00:00.000Z' }
      },
      'gemini-2.5-pro': {
        displayName: 'Gemini 2.5 Pro',
        quotaInfo: { resetTime: '2026-04-24T13:00:00.000Z' }
      }
    }
  }

  it('returns quota via auth.json', async () => {
    setupAuthJsonValid()
    netFetchMock.mockImplementation((url: string) => {
      if (url.includes('fetchAvailableModels')) {
        return Promise.resolve(makeResponse(modelsResponse))
      }
      if (url.includes('loadCodeAssist')) {
        return Promise.resolve(makeResponse({ cloudaicompanionProject: 'proj-123' }))
      }
      return Promise.resolve(makeResponse({}, 404))
    })
    const result = await fetchAntigravityRateLimits(true)
    expect(result.status).toBe('ok')
    expect(result.provider).toBe('antigravity')
    expect(result.buckets).toHaveLength(2)
    expect(result.buckets?.[0]?.name).toBe('Claude Sonnet 4.6')
    expect(result.buckets?.[0]?.usedPercent).toBe(25)
    expect(result.session?.resetsAt).toBe(Date.parse('2026-04-24T13:00:00.000Z'))
  })

  it('prefers the agy keychain token over file credentials', async () => {
    setupAuthJsonValid()
    keychainMock.mockResolvedValue({
      access_token: 'keychain-token',
      refresh_token: 'keychain-refresh',
      expiry_date: Date.now() + 3600_000,
      source: 'keychain'
    })
    netFetchMock.mockImplementation((url: string) => {
      if (url.includes('fetchAvailableModels')) {
        return Promise.resolve(makeResponse(modelsResponse))
      }
      if (url.includes('loadCodeAssist')) {
        return Promise.resolve(makeResponse({ cloudaicompanionProject: 'proj-keychain' }))
      }
      return Promise.resolve(makeResponse({}, 404))
    })
    const result = await fetchAntigravityRateLimits(true)
    expect(result.status).toBe('ok')
    const authHeader = netFetchMock.mock.calls[0]?.[1]?.headers?.Authorization
    expect(authHeader).toBe('Bearer keychain-token')
  })

  it('reports a clear error when the keychain token is expired', async () => {
    keychainMock.mockResolvedValue({
      access_token: 'expired-token',
      refresh_token: 'keychain-refresh',
      expiry_date: Date.now() - 1000,
      source: 'keychain'
    })
    const result = await fetchAntigravityRateLimits(true)
    expect(result.status).toBe('error')
    expect(result.error).toContain('run agy')
  })

  it('returns quota via oauth_creds.json', async () => {
    readFileMock.mockImplementation(async (p: string) => {
      if (p.includes('oauth_creds.json')) {
        return JSON.stringify({
          access_token: 'valid-token',
          refresh_token: 'refresh-token',
          expiry_date: Date.now() + 3600_000
        })
      }
      throw { code: 'ENOENT' }
    })
    netFetchMock.mockImplementation((url: string) => {
      if (url.includes('fetchAvailableModels')) {
        return Promise.resolve(makeResponse(modelsResponse))
      }
      if (url.includes('loadCodeAssist')) {
        return Promise.resolve(makeResponse({ cloudaicompanionProject: 'proj-123' }))
      }
      return Promise.resolve(makeResponse({}, 404))
    })
    const result = await fetchAntigravityRateLimits(true)
    expect(result.status).toBe('ok')
    expect(result.provider).toBe('antigravity')
    expect(result.buckets).toHaveLength(2)
  })
})
