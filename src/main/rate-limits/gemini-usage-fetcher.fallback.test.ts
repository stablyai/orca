import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setMainHttpClient } from '../network/http-client'
import {
  expiredCreds,
  makeResponse,
  quotaResponse,
  validCreds
} from './gemini-usage-fetcher.test-fixtures'

const { readFileMock, extractCredsMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  extractCredsMock: vi.fn()
}))
const fetchMock = vi.fn()

// Mock extraction at its module boundary so tests cover refresh/quota behavior independently of install layouts.
vi.mock('./gemini-cli-oauth-extractor', () => ({
  extractOAuthClientCredentials: extractCredsMock
}))

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock
}))

// Refresh must never write the developer's real ~/.gemini.
vi.mock('../integration-credential-file', () => ({
  writeCredentialFileAtomic: vi.fn().mockReturnValue(true)
}))

import { fetchGeminiRateLimits } from './gemini-usage-fetcher'

setMainHttpClient({ fetch: fetchMock, proxySession: () => null })

describe('fetchGeminiRateLimits fallback oauth creds', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-24T12:00:00.000Z'))
    readFileMock.mockReset()
    extractCredsMock.mockReset()
    fetchMock.mockReset()
    extractCredsMock.mockResolvedValue({
      clientId: 'client-id-123',
      clientSecret: 'client-secret-456'
    })
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
    fetchMock
      .mockResolvedValueOnce(makeResponse({ cloudaicompanionProject: 'cli-proj-456' }))
      .mockResolvedValueOnce(makeResponse(quotaResponse))

    const result = await fetchGeminiRateLimits(true)

    expect(result.status).toBe('ok')
    expect(result.error).toBeNull()
    expect(result.session).not.toBeNull()

    const quotaCall = fetchMock.mock.calls.find(
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
    fetchMock
      .mockResolvedValueOnce(
        makeResponse({ access_token: 'bundle-refreshed-token', expires_in: 3600 })
      )
      .mockResolvedValueOnce(makeResponse({ cloudaicompanionProject: 'cli-proj-456' }))
      .mockResolvedValueOnce(makeResponse(quotaResponse))

    const result = await fetchGeminiRateLimits(true)

    expect(result.status).toBe('ok')
    expect(result.error).toBeNull()
    expect(result.session).not.toBeNull()

    const refreshCall = fetchMock.mock.calls.find(
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
    extractCredsMock.mockResolvedValue(null)

    const result = await fetchGeminiRateLimits(true)

    expect(result.status).toBe('error')
    expect(result.error).toContain('Token refresh failed')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
  })

  it('returns error when loadCodeAssist cannot resolve a project for oauth_creds path', async () => {
    // Missing project must fail before quota API calls; posting empty project produces a misleading auth-like 400.
    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath.includes('auth.json')) {
        return JSON.stringify({})
      }
      if (filePath.includes('oauth_creds.json')) {
        return JSON.stringify(validCreds)
      }
      throw { code: 'ENOENT' }
    })
    fetchMock.mockResolvedValueOnce(makeResponse('Internal Server Error', 500))

    const result = await fetchGeminiRateLimits(true)

    expect(result.status).toBe('error')
    expect(result.error).toContain('Gemini project ID not found')
  })

  it('returns unavailable without reading OAuth files when geminiCliOAuthEnabled=false', async () => {
    const result = await fetchGeminiRateLimits(false)

    expect(result.status).toBe('unavailable')
    expect(result.error).toContain('disabled')
    expect(readFileMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
