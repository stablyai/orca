import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  expiredCreds,
  makeResponse,
  oauth2JsContent,
  quotaResponse,
  validCreds
} from './gemini-usage-fetcher.test-fixtures'

const {
  readFileMock,
  existsSyncMock,
  readdirSyncMock,
  readFileSyncMock,
  realpathSyncMock,
  execSyncMock,
  netFetchMock
} = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  existsSyncMock: vi.fn(),
  readdirSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  realpathSyncMock: vi.fn(),
  execSyncMock: vi.fn(),
  netFetchMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock
}))

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  readdirSync: readdirSyncMock,
  readFileSync: readFileSyncMock,
  realpathSync: realpathSyncMock
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
    existsSyncMock.mockReset()
    readdirSyncMock.mockReset()
    readFileSyncMock.mockReset()
    realpathSyncMock.mockReset()
    execSyncMock.mockReset()
    netFetchMock.mockReset()
    // Why: default to "binary found, symlink already resolved, no package roots found"
    // so individual tests only override what they care about.
    realpathSyncMock.mockImplementation((p: string) => p)
    existsSyncMock.mockReturnValue(false)
    readdirSyncMock.mockReturnValue([])
    readFileSyncMock.mockImplementation(() => {
      throw new Error('ENOENT')
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

    const result = await fetchGeminiRateLimits()

    expect(result.status).toBe('ok')
    expect(result.error).toBeNull()
    expect(result.session).not.toBeNull()
  })

  it('falls back to oauth_creds.json and resolves project via loadCodeAssist', async () => {
    // Why: simulates the Homebrew known-path hit — realpathSync resolves the symlink,
    // then extractFromKnownPaths reads oauth2.js from the libexec/lib layout.
    execSyncMock.mockReturnValue('/opt/homebrew/bin/gemini')
    realpathSyncMock.mockReturnValue('/opt/homebrew/Cellar/gemini-cli/0.38.2/bin/gemini')
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

  it('falls back to oauth_creds.json and refreshes via bundle dir when expired', async () => {
    // Why: simulates the bundle-dir fallback — known paths miss (existsSync false by default),
    // findGeminiPackageRoot finds package.json via readFileSync, then extractFromBundleDir
    // reads an oauth2-provider chunk that contains the credentials.
    execSyncMock.mockReturnValue('/usr/local/bin/gemini')
    realpathSyncMock.mockReturnValue('/usr/local/bin/gemini')
    const pkgJsonPath = '/usr/local/package.json'
    const bundleDir = '/usr/local/bundle'
    existsSyncMock.mockImplementation((p: string) => {
      return p === pkgJsonPath || p === bundleDir
    })
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === pkgJsonPath) {
        return JSON.stringify({ name: '@google/gemini-cli' })
      }
      throw new Error('ENOENT')
    })
    readdirSyncMock.mockImplementation((dir: string) => {
      if (dir === bundleDir) {
        return ['oauth2-provider-ABCD.js']
      }
      return []
    })
    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath.includes('auth.json')) {
        return JSON.stringify({})
      }
      if (filePath.includes('oauth_creds.json')) {
        return JSON.stringify(expiredCreds)
      }
      if (filePath.includes('oauth2-provider-ABCD.js')) {
        return oauth2JsContent
      }
      throw { code: 'ENOENT' }
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
    // existsSync returns false by default — no known-path or walk-up match found
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
