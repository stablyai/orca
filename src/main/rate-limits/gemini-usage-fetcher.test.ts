import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  authJsonGoogle,
  authJsonGoogleExpired,
  makeResponse,
  quotaResponse
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

// getBucketName and deriveSessionSummary unit tests live in gemini-bucket-helpers.test.ts

describe('fetchGeminiRateLimits', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-24T12:00:00.000Z'))
    readFileMock.mockReset()
    existsSyncMock.mockReset()
    realpathSyncMock.mockReset()
    execSyncMock.mockReset()
    netFetchMock.mockReset()
    // Why: default to "gemini binary not found" so credential extraction
    // short-circuits; individual tests override this when they need refresh.
    execSyncMock.mockImplementation(() => {
      throw new Error('not found')
    })
    realpathSyncMock.mockImplementation((p: string) => p)
    existsSyncMock.mockReturnValue(false)
    readdirSyncMock.mockReturnValue([])
    readFileSyncMock.mockImplementation(() => {
      throw new Error('ENOENT')
    })
  })

  function setupAuthJsonNotFound(): void {
    readFileMock.mockRejectedValue({ code: 'ENOENT' })
  }

  function setupAuthJsonGoogleValid(): void {
    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath.includes('auth.json')) {
        return JSON.stringify(authJsonGoogle)
      }
      throw { code: 'ENOENT' }
    })
  }

  function setupAuthJsonGoogleExpired(): void {
    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath.includes('auth.json')) {
        return JSON.stringify(authJsonGoogleExpired)
      }
      throw { code: 'ENOENT' }
    })
  }

  it('returns unavailable when no auth.json and no oauth_creds.json exist', async () => {
    setupAuthJsonNotFound()

    const result = await fetchGeminiRateLimits()

    expect(result.status).toBe('unavailable')
    expect(result.provider).toBe('gemini')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
    expect(result.error).toContain('credentials not found')
  })

  it('returns quota via auth.json with valid token (single window)', async () => {
    setupAuthJsonGoogleValid()
    netFetchMock.mockResolvedValueOnce(makeResponse(quotaResponse))

    const result = await fetchGeminiRateLimits()

    expect(result.status).toBe('ok')
    expect(result.provider).toBe('gemini')
    expect(result.error).toBeNull()
    expect(result.weekly).toBeNull()

    // Minimum remainingFraction is 0.75 -> usedPercent 25
    expect(result.session).toEqual({
      usedPercent: 25,
      windowMinutes: 60,
      resetsAt: new Date('2026-04-24T13:00:00.000Z').getTime(),
      resetDescription: null
    })

    expect(result.buckets).toHaveLength(2)
    expect(result.buckets![0].name).toBe('Pro')
    expect(result.buckets![0].usedPercent).toBe(25)
    expect(result.buckets![1].name).toBe('Flash')
    expect(result.buckets![1].usedPercent).toBe(10)

    const quotaCall = netFetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('retrieveUserQuota')
    )
    expect(quotaCall).toBeDefined()
    const quotaBody = JSON.parse((quotaCall![1] as RequestInit).body as string)
    expect(quotaBody.project).toBe('proj-123')
  })

  it('maps unknown model IDs to fallback bucket names', async () => {
    setupAuthJsonGoogleValid()
    netFetchMock.mockResolvedValueOnce(
      makeResponse([
        {
          remainingFraction: 0.5,
          resetTime: '2026-04-24T13:00:00.000Z',
          modelId: 'gemini-experimental'
        }
      ])
    )

    const result = await fetchGeminiRateLimits()

    expect(result.status).toBe('ok')
    expect(result.buckets).toHaveLength(1)
    expect(result.buckets![0].name).toBe('Exp')
    expect(result.session!.usedPercent).toBe(50)
  })

  it('handles empty bucket list with null session', async () => {
    setupAuthJsonGoogleValid()
    netFetchMock.mockResolvedValueOnce(makeResponse([]))

    const result = await fetchGeminiRateLimits()

    expect(result.status).toBe('ok')
    expect(result.buckets).toEqual([])
    expect(result.session).toBeNull()
  })

  it('returns error when auth.json token is expired and bundle credentials unavailable', async () => {
    // execSyncMock already throws by default (gemini not found) → refresh fails
    setupAuthJsonGoogleExpired()

    const result = await fetchGeminiRateLimits()

    expect(result.status).toBe('error')
    expect(result.error).toContain('Token refresh failed')
    expect(result.session).toBeNull()
  })

  it('returns ok when auth.json token is expired but bundle refresh succeeds', async () => {
    setupAuthJsonGoogleExpired()
    execSyncMock.mockReturnValue('/opt/homebrew/bin/gemini')
    realpathSyncMock.mockReturnValue('/opt/homebrew/Cellar/gemini-cli/0.38.2/bin/gemini')
    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath.includes('auth.json')) {
        const { authJsonGoogleExpired } = await import('./gemini-usage-fetcher.test-fixtures')
        return JSON.stringify(authJsonGoogleExpired)
      }
      if (filePath.includes('oauth2.js')) {
        const { oauth2JsContent } = await import('./gemini-usage-fetcher.test-fixtures')
        return oauth2JsContent
      }
      throw { code: 'ENOENT' }
    })
    netFetchMock
      .mockResolvedValueOnce(makeResponse({ access_token: 'refreshed-token' }))
      .mockResolvedValueOnce(makeResponse(quotaResponse))

    const result = await fetchGeminiRateLimits()

    expect(result.status).toBe('ok')
    expect(result.session).not.toBeNull()
  })

  it('handles wrapped buckets response from quota API', async () => {
    setupAuthJsonGoogleValid()
    netFetchMock.mockResolvedValueOnce(makeResponse({ buckets: quotaResponse }))

    const result = await fetchGeminiRateLimits()

    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(25)
  })

  it('handles top-level array response from quota API', async () => {
    setupAuthJsonGoogleValid()
    netFetchMock.mockResolvedValueOnce(makeResponse(quotaResponse))

    const result = await fetchGeminiRateLimits()

    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(25)
  })

  it('uses managedProjectId when projectId is empty in pipe-delimited refresh', async () => {
    const authWithEmptyProject = {
      google: {
        type: 'oauth',
        access: 'auth-json-access-token',
        expires: new Date('2026-04-24T13:00:00.000Z').getTime(),
        refresh: 'refresh-token-abc||managed-789'
      }
    }
    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath.includes('auth.json')) {
        return JSON.stringify(authWithEmptyProject)
      }
      throw { code: 'ENOENT' }
    })
    netFetchMock.mockResolvedValueOnce(makeResponse(quotaResponse))

    await fetchGeminiRateLimits()

    const quotaCall = netFetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('retrieveUserQuota')
    )
    expect(quotaCall).toBeDefined()
    const quotaBody = JSON.parse((quotaCall![1] as RequestInit).body as string)
    expect(quotaBody.project).toBe('managed-789')
  })

  it('returns error when auth.json quota fetch returns 401 and bundle credentials unavailable', async () => {
    // execSyncMock throws by default → credential extraction fails → refresh fails
    setupAuthJsonGoogleValid()
    netFetchMock.mockResolvedValueOnce(makeResponse('Unauthorized', 401))

    const result = await fetchGeminiRateLimits()

    expect(result.status).toBe('error')
    expect(result.error).toContain('Token refresh failed')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
  })

  it('retries with refreshed token when auth.json quota fetch returns 401 and bundle succeeds', async () => {
    setupAuthJsonGoogleValid()
    execSyncMock.mockReturnValue('/opt/homebrew/bin/gemini')
    realpathSyncMock.mockReturnValue('/opt/homebrew/Cellar/gemini-cli/0.38.2/bin/gemini')
    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath.includes('auth.json')) {
        const { authJsonGoogle } = await import('./gemini-usage-fetcher.test-fixtures')
        return JSON.stringify(authJsonGoogle)
      }
      if (filePath.includes('oauth2.js')) {
        const { oauth2JsContent } = await import('./gemini-usage-fetcher.test-fixtures')
        return oauth2JsContent
      }
      throw { code: 'ENOENT' }
    })
    netFetchMock
      .mockResolvedValueOnce(makeResponse('Unauthorized', 401))
      .mockResolvedValueOnce(makeResponse({ access_token: 'retried-token' }))
      .mockResolvedValueOnce(makeResponse(quotaResponse))

    const result = await fetchGeminiRateLimits()

    expect(result.status).toBe('ok')
    expect(result.session).not.toBeNull()
  })
})
