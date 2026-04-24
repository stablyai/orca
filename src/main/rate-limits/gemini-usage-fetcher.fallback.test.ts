import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  expiredCreds,
  makeDirent,
  makeResponse,
  oauth2JsContent,
  quotaResponse,
  validCreds
} from './gemini-usage-fetcher.test-fixtures'

const { readFileMock, readdirSyncMock, execSyncMock, netFetchMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  readdirSyncMock: vi.fn(),
  execSyncMock: vi.fn(),
  netFetchMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock
}))

vi.mock('node:fs', () => ({
  readdirSync: readdirSyncMock
}))

vi.mock('node:child_process', () => ({
  execSync: execSyncMock
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
    readdirSyncMock.mockReset()
    execSyncMock.mockReset()
    netFetchMock.mockReset()
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

    const result = await fetchGeminiRateLimits()

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
      if (filePath.includes('oauth2.js')) {
        return oauth2JsContent
      }
      throw new Error('Unexpected readFile call')
    })
    execSyncMock.mockReturnValue('/usr/local/bin/gemini')
    readdirSyncMock.mockImplementation((dirPath: string) => {
      if (dirPath === '/usr/local/bin') {
        return [makeDirent('gemini', false)]
      }
      return []
    })
    netFetchMock
      .mockResolvedValueOnce(makeResponse({ cloudaicompanionProject: 'cli-proj-456' }))
      .mockResolvedValueOnce(makeResponse(quotaResponse))

    const result = await fetchGeminiRateLimits()

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

  it('falls back to oauth_creds.json and refreshes via bundle when expired', async () => {
    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath.includes('auth.json')) {
        return JSON.stringify({})
      }
      if (filePath.includes('oauth_creds.json')) {
        return JSON.stringify(expiredCreds)
      }
      if (filePath.includes('oauth2.js')) {
        return oauth2JsContent
      }
      throw new Error('Unexpected readFile call')
    })
    execSyncMock.mockReturnValue('/usr/local/bin/gemini')
    readdirSyncMock.mockImplementation((dirPath: string) => {
      if (dirPath === '/usr/local/bin') {
        return [makeDirent('gemini', false), makeDirent('node_modules', true)]
      }
      if (dirPath === '/usr/local/bin/node_modules') {
        return [makeDirent('oauth2.js', false)]
      }
      return []
    })
    netFetchMock
      .mockResolvedValueOnce(makeResponse({ access_token: 'bundle-refreshed-token' }))
      .mockResolvedValueOnce(makeResponse({ cloudaicompanionProject: 'cli-proj-456' }))
      .mockResolvedValueOnce(makeResponse(quotaResponse))

    const result = await fetchGeminiRateLimits()

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
      throw new Error('Unexpected readFile call')
    })
    execSyncMock.mockReturnValue('/usr/local/bin/gemini')
    readdirSyncMock.mockImplementation(() => [])
    netFetchMock.mockResolvedValueOnce(makeResponse({ error: 'invalid_grant' }, 400))

    const result = await fetchGeminiRateLimits()

    expect(result.status).toBe('error')
    expect(result.error).toContain('Token refresh failed')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
  })

  it('proceeds with empty projectId when loadCodeAssist fails for fallback path', async () => {
    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath.includes('auth.json')) {
        return JSON.stringify({})
      }
      if (filePath.includes('oauth_creds.json')) {
        return JSON.stringify(validCreds)
      }
      throw new Error('Unexpected readFile call')
    })
    netFetchMock
      .mockResolvedValueOnce(makeResponse('Internal Server Error', 500))
      .mockResolvedValueOnce(makeResponse(quotaResponse))

    const result = await fetchGeminiRateLimits()

    expect(result.status).toBe('ok')
    expect(result.session).not.toBeNull()

    const quotaCall = netFetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('retrieveUserQuota')
    )
    expect(quotaCall).toBeDefined()
    const quotaBody = JSON.parse((quotaCall![1] as RequestInit).body as string)
    expect(quotaBody.project).toBe('')
  })
})
