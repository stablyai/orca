import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  authJsonGoogle,
  authJsonGoogleExpired,
  makeResponse,
  quotaResponse,
  oauth2JsContent
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

vi.mock('node:fs/promises', () => ({ readFile: readFileMock }))
vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  readdirSync: readdirSyncMock,
  readFileSync: readFileSyncMock,
  realpathSync: realpathSyncMock
}))
vi.mock('node:child_process', () => ({
  execSync: execSyncMock,
  exec: vi.fn((_cmd, cb) => {
    if (typeof cb === 'function') {
      cb(null, { stdout: '', stderr: '' })
    }
  })
}))
vi.mock('electron', () => ({ net: { fetch: netFetchMock } }))

import { fetchGeminiRateLimits } from './gemini-usage-fetcher'

describe('fetchGeminiRateLimits', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-24T12:00:00.000Z'))
    readFileMock.mockReset()
    existsSyncMock.mockReset()
    realpathSyncMock.mockReset()
    execSyncMock.mockReset()
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
    execSyncMock.mockImplementation(() => {
      throw new Error('not found')
    })
    realpathSyncMock.mockImplementation((p: string) => {
      return p
    })
    existsSyncMock.mockReturnValue(false)
    readdirSyncMock.mockReturnValue([])
    readFileSyncMock.mockImplementation(() => {
      throw new Error('ENOENT')
    })
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
  const setupAuthJsonExpired = () => {
    readFileMock.mockImplementation(async (p: string) => {
      if (p.includes('auth.json')) {
        return JSON.stringify(authJsonGoogleExpired)
      }
      throw { code: 'ENOENT' }
    })
  }

  it('returns unavailable when no credentials exist', async () => {
    const result = await fetchGeminiRateLimits(true)
    expect(result.status).toBe('unavailable')
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
    const result = await fetchGeminiRateLimits(true)
    expect(result.status).toBe('ok')
    expect(result.buckets).toHaveLength(2)
  })

  it('deduplicates buckets', async () => {
    setupAuthJsonValid()
    netFetchMock.mockImplementation((url: string) => {
      if (url.includes('retrieveUserQuota')) {
        return Promise.resolve(
          makeResponse([
            {
              remainingFraction: 0.82,
              resetTime: '2026-04-24T13:00:00.000Z',
              modelId: 'gemini-1.5-flash'
            },
            {
              remainingFraction: 0.82,
              resetTime: '2026-04-24T13:00:00.000Z',
              modelId: 'gemini-3-flash-preview'
            }
          ])
        )
      }
      if (url.includes('loadCodeAssist')) {
        return Promise.resolve(makeResponse({ cloudaicompanionProject: 'proj-123' }))
      }
      return Promise.resolve(makeResponse({}, 404))
    })
    const result = await fetchGeminiRateLimits(true)
    expect(result.status).toBe('ok')
    expect(result.buckets).toHaveLength(1)
    expect(result.buckets![0].name).toBe('1.5 Flash')
  })

  it('handles empty bucket list', async () => {
    setupAuthJsonValid()
    netFetchMock.mockImplementation((url: string) => {
      if (url.includes('retrieveUserQuota')) {
        return Promise.resolve(makeResponse([]))
      }
      if (url.includes('loadCodeAssist')) {
        return Promise.resolve(makeResponse({ cloudaicompanionProject: 'proj-123' }))
      }
      return Promise.resolve(makeResponse({}, 404))
    })
    const result = await fetchGeminiRateLimits(true)
    expect(result.status).toBe('ok')
    expect(result.buckets).toEqual([])
  })

  it('returns error when token refresh fails', async () => {
    vi.useRealTimers()
    setupAuthJsonExpired()
    const result = await fetchGeminiRateLimits(true)
    expect(result.status).toBe('error')
    expect(result.error).toContain('Token refresh failed')
    vi.useFakeTimers()
  })

  it('handles wrapped buckets response', async () => {
    setupAuthJsonValid()
    netFetchMock.mockImplementation((url: string) => {
      if (url.includes('retrieveUserQuota')) {
        return Promise.resolve(makeResponse({ buckets: quotaResponse }))
      }
      if (url.includes('loadCodeAssist')) {
        return Promise.resolve(makeResponse({ cloudaicompanionProject: 'proj-123' }))
      }
      return Promise.resolve(makeResponse({}, 404))
    })
    const result = await fetchGeminiRateLimits(true)
    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(25)
  })

  it('filters out NaN buckets', async () => {
    setupAuthJsonValid()
    netFetchMock.mockImplementation((url: string) => {
      if (url.includes('retrieveUserQuota')) {
        return Promise.resolve(
          makeResponse([
            {
              remainingFraction: NaN,
              resetTime: '2026-04-24T13:00:00.000Z',
              modelId: 'gemini-1.5-pro'
            },
            {
              remainingFraction: 0.9,
              resetTime: '2026-04-24T13:00:00.000Z',
              modelId: 'gemini-1.5-flash'
            }
          ])
        )
      }
      if (url.includes('loadCodeAssist')) {
        return Promise.resolve(makeResponse({ cloudaicompanionProject: 'proj-123' }))
      }
      return Promise.resolve(makeResponse({}, 404))
    })
    const result = await fetchGeminiRateLimits(true)
    expect(result.status).toBe('ok')
    expect(result.buckets).toHaveLength(1)
  })

  it('retries refresh on 401', async () => {
    vi.useRealTimers()
    setupAuthJsonValid()
    execSyncMock.mockReturnValue('/bin/gemini')
    realpathSyncMock.mockReturnValue('/bin/gemini')
    readFileMock.mockImplementation(async (p: string) => {
      if (p.includes('auth.json')) {
        return JSON.stringify(authJsonGoogle)
      }
      if (p.includes('oauth2.js')) {
        return oauth2JsContent
      }
      throw { code: 'ENOENT' }
    })
    netFetchMock.mockImplementation((url: string) => {
      if (url.includes('retrieveUserQuota')) {
        return Promise.resolve(makeResponse(quotaResponse))
      }
      if (url.includes('token')) {
        return Promise.resolve(makeResponse({ access_token: 'retried-token' }))
      }
      if (url.includes('loadCodeAssist')) {
        return Promise.resolve(makeResponse({ cloudaicompanionProject: 'proj-123' }))
      }
      return Promise.resolve(makeResponse({}, 404))
    })
    const result = await fetchGeminiRateLimits(true)
    expect(result.status).toBe('ok')
    vi.useFakeTimers()
  })
})
