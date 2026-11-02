import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setMainHttpClient } from '../network/http-client'
import { authJsonGoogle, makeResponse, quotaResponse } from './gemini-usage-fetcher.test-fixtures'

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

describe('fetchGeminiRateLimits', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-24T12:00:00.000Z'))
    readFileMock.mockReset()
    extractCredsMock.mockReset()
    fetchMock.mockReset()
    fetchMock.mockImplementation((url: string) => {
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

  it('tags a quota request that throws as a network failure', async () => {
    setupAuthJsonValid()
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('retrieveUserQuota')) {
        return Promise.reject(new Error('net::ERR_PROXY_CONNECTION_FAILED'))
      }
      if (url.includes('loadCodeAssist')) {
        return Promise.resolve(makeResponse({ cloudaicompanionProject: 'proj-123' }))
      }
      return Promise.resolve(makeResponse({}, 404))
    })
    const result = await fetchGeminiRateLimits(true)
    expect(result.status).toBe('error')
    expect(result.error).toBe('net::ERR_PROXY_CONNECTION_FAILED')
    expect(result.usageMetadata?.failureKind).toBe('network')
  })

  it('deduplicates buckets', async () => {
    setupAuthJsonValid()
    fetchMock.mockImplementation((url: string) => {
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

  it('handles wrapped buckets response', async () => {
    setupAuthJsonValid()
    fetchMock.mockImplementation((url: string) => {
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
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('retrieveUserQuota')) {
        return Promise.resolve(
          makeResponse([
            {
              remainingFraction: Number.NaN,
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
    setupAuthJsonValid()
    extractCredsMock.mockResolvedValue({ clientId: 'cid', clientSecret: 'csec' })
    let quotaCallCount = 0
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('retrieveUserQuota')) {
        quotaCallCount += 1
        if (quotaCallCount === 1) {
          return Promise.resolve(makeResponse({ error: 'Unauthenticated' }, 401))
        }
        return Promise.resolve(makeResponse(quotaResponse))
      }
      if (url.includes('token')) {
        return Promise.resolve(makeResponse({ access_token: 'retried-token', expires_in: 3600 }))
      }
      if (url.includes('loadCodeAssist')) {
        return Promise.resolve(makeResponse({ cloudaicompanionProject: 'proj-123' }))
      }
      return Promise.resolve(makeResponse({}, 404))
    })
    const result = await fetchGeminiRateLimits(true)
    expect(result.status).toBe('ok')
    expect(quotaCallCount).toBe(2)
  })
})
