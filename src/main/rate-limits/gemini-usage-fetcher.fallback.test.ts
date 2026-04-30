import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  expiredCreds,
  makeResponse,
  quotaResponse,
  validCreds
} from './gemini-usage-fetcher.test-fixtures'

const { readFileMock, extractCredsMock, netFetchMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  extractCredsMock: vi.fn(),
  netFetchMock: vi.fn()
}))

// Why: mock the CLI-credential extractor at the module boundary. The extractor
// is a self-contained dependency with a simple async contract (returns a
// { clientId, clientSecret } record or null). Mocking it here keeps these
// tests focused on the oauth_creds.json refresh → loadCodeAssist → quota
// flow rather than on filesystem plumbing, and avoids having to keep pace
// with extractor internals when they change.
vi.mock('./gemini-cli-oauth-extractor', () => ({
  extractOAuthClientCredentials: extractCredsMock
}))

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
  // Why: saveGeminiCredentials is exercised on the refresh path. The atomic
  // tmp+rename write has no observable side effect in these tests, so the
  // stubs just resolve.
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

import { fetchGeminiRateLimits } from './gemini-usage-fetcher'

describe('fetchGeminiRateLimits fallback oauth creds', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-24T12:00:00.000Z'))
    readFileMock.mockReset()
    extractCredsMock.mockReset()
    netFetchMock.mockReset()
    extractCredsMock.mockResolvedValue({
      clientId: 'client-id-123',
      clientSecret: 'client-secret-456'
    })
  })

  it('falls back to oauth_creds.json when auth.json has no google key', async () => {
    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath.includes('auth.json')) {
        return JSON.stringify({ 'opencode-go': { type: 'api', key: 'k' } })
      }
      if (filePath.includes('oauth_creds.json')) {
        return JSON.stringify(validCreds)
      }
      throw { code: 'ENOENT' }
    })
    netFetchMock
      .mockResolvedValueOnce(makeResponse({ cloudaicompanionProject: 'proj-123' }))
      .mockResolvedValueOnce(makeResponse(quotaResponse))

    const result = await fetchGeminiRateLimits(true)

    expect(result.status).toBe('ok')
    expect(result.error).toBeNull()
    expect(result.session).not.toBeNull()
  })

  it('falls back to oauth_creds.json and resolves project via loadCodeAssist', async () => {
    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath.includes('auth.json')) {
        return JSON.stringify({})
      }
      if (filePath.includes('oauth_creds.json')) {
        return JSON.stringify(validCreds)
      }
      throw { code: 'ENOENT' }
    })
    netFetchMock
      .mockResolvedValueOnce(makeResponse({ cloudaicompanionProject: 'cli-proj-456' }))
      .mockResolvedValueOnce(makeResponse(quotaResponse))

    const result = await fetchGeminiRateLimits(true)

    expect(result.status).toBe('ok')
    expect(result.error).toBeNull()
    expect(result.session).not.toBeNull()

    const quotaCall = netFetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('retrieveUserQuota')
    )
    expect(quotaCall).toBeDefined()
    const quotaBody = JSON.parse((quotaCall![1] as RequestInit).body as string)
    expect(quotaBody.project).toBe('cli-proj-456')
  })

  it('refreshes via bundled client credentials when expiry passed', async () => {
    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath.includes('auth.json')) {
        return JSON.stringify({})
      }
      if (filePath.includes('oauth_creds.json')) {
        return JSON.stringify(expiredCreds)
      }
      throw { code: 'ENOENT' }
    })
    netFetchMock
      .mockResolvedValueOnce(
        makeResponse({ access_token: 'bundle-refreshed-token', expires_in: 3600 })
      )
      .mockResolvedValueOnce(makeResponse({ cloudaicompanionProject: 'cli-proj-456' }))
      .mockResolvedValueOnce(makeResponse(quotaResponse))

    const result = await fetchGeminiRateLimits(true)

    expect(result.status).toBe('ok')
    expect(result.error).toBeNull()
    expect(result.session).not.toBeNull()

    const refreshCall = netFetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('oauth2.googleapis.com')
    )
    expect(refreshCall).toBeDefined()
    const refreshBody = new URLSearchParams((refreshCall![1] as RequestInit).body as string)
    expect(refreshBody.get('client_id')).toBe('client-id-123')
    expect(refreshBody.get('client_secret')).toBe('client-secret-456')
  })

  it('returns error when oauth_creds.json token expired and bundle refresh fails', async () => {
    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath.includes('auth.json')) {
        return JSON.stringify({})
      }
      if (filePath.includes('oauth_creds.json')) {
        return JSON.stringify(expiredCreds)
      }
      throw { code: 'ENOENT' }
    })
    // Simulate: no Gemini CLI installed, so the extractor returns null and
    // tryRefreshTokenFromBundle can't obtain client credentials to refresh.
    extractCredsMock.mockResolvedValue(null)

    const result = await fetchGeminiRateLimits(true)

    expect(result.status).toBe('error')
    expect(result.error).toContain('Token refresh failed')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
  })

  it('returns error when loadCodeAssist cannot resolve a project for oauth_creds path', async () => {
    // Why: when the fallback (oauth_creds.json) path has no project embedded
    // and loadCodeAssist fails, we surface a clear "project ID not found"
    // error rather than silently posting an empty project to the quota API —
    // an empty project causes a 400 that looks like an auth failure.
    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath.includes('auth.json')) {
        return JSON.stringify({})
      }
      if (filePath.includes('oauth_creds.json')) {
        return JSON.stringify(validCreds)
      }
      throw { code: 'ENOENT' }
    })
    netFetchMock.mockResolvedValueOnce(makeResponse('Internal Server Error', 500))

    const result = await fetchGeminiRateLimits(true)

    expect(result.status).toBe('error')
    expect(result.error).toContain('Gemini project ID not found')
  })

  it('returns unavailable when geminiCliOAuthEnabled=false and no google entry in auth.json', async () => {
    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath.includes('auth.json')) {
        return JSON.stringify({ 'opencode-go': { type: 'api', key: 'k' } })
      }
      throw { code: 'ENOENT' }
    })

    const result = await fetchGeminiRateLimits(false)

    expect(result.status).toBe('unavailable')
    expect(result.error).toContain('disabled')
    // No network calls should have been made.
    expect(netFetchMock).not.toHaveBeenCalled()
  })
})
