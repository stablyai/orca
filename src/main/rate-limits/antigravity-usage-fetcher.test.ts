import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authJsonGoogle, makeResponse, quotaResponse } from './gemini-usage-fetcher.test-fixtures'

const { readFileMock, extractCredsMock, netFetchMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  extractCredsMock: vi.fn(),
  netFetchMock: vi.fn()
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

import { fetchAntigravityRateLimits } from './antigravity-usage-fetcher'

describe('fetchAntigravityRateLimits', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-24T12:00:00.000Z'))
    readFileMock.mockReset()
    extractCredsMock.mockReset()
    netFetchMock.mockReset()
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

  it('returns quota via auth.json', async () => {
    setupAuthJsonValid()
    netFetchMock.mockImplementation((url: string) => {
      if (url.includes('retrieveUserQuota')) {
        return Promise.resolve(makeResponse(quotaResponse))
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
      if (url.includes('retrieveUserQuota')) {
        return Promise.resolve(makeResponse(quotaResponse))
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
