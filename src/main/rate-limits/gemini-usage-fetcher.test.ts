import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RateLimitBucket } from '../../shared/rate-limit-types'
import {
  authJsonGoogle,
  authJsonGoogleExpired,
  makeResponse,
  quotaResponse
} from './gemini-usage-fetcher.test-fixtures'

const { readFileMock, netFetchMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  netFetchMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock
}))

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

import { fetchGeminiRateLimits, getBucketName, deriveSessionSummary } from './gemini-usage-fetcher'

describe('getBucketName', () => {
  it('maps known model IDs to stable names', () => {
    expect(getBucketName('gemini-2.5-pro')).toBe('Pro')
    expect(getBucketName('gemini-2.5-flash')).toBe('Flash')
    expect(getBucketName('gemini-2.0-flash-lite')).toBe('Flash Lite')
  })

  it('returns a deterministic fallback for unknown model IDs', () => {
    expect(getBucketName('gemini-experimental')).toBe('Unknown (gemini-experimental)')
    expect(getBucketName('some-random-id')).toBe('Unknown (some-random-id)')
  })
})

describe('deriveSessionSummary', () => {
  it('returns null for empty buckets', () => {
    expect(deriveSessionSummary([])).toBeNull()
  })

  it('picks the most constrained bucket (highest usedPercent) as session summary', () => {
    const buckets: RateLimitBucket[] = [
      { name: 'Pro', usedPercent: 30, windowMinutes: 300, resetsAt: null, resetDescription: null },
      {
        name: 'Flash',
        usedPercent: 80,
        windowMinutes: 300,
        resetsAt: null,
        resetDescription: null
      },
      {
        name: 'Flash Lite',
        usedPercent: 10,
        windowMinutes: 300,
        resetsAt: null,
        resetDescription: null
      }
    ]
    const summary = deriveSessionSummary(buckets)
    expect(summary).not.toBeNull()
    expect(summary!.usedPercent).toBe(80)
    expect(summary!.windowMinutes).toBe(300)
  })

  it('preserves reset metadata from the most constrained bucket', () => {
    const buckets: RateLimitBucket[] = [
      {
        name: 'Pro',
        usedPercent: 30,
        windowMinutes: 300,
        resetsAt: 1000,
        resetDescription: '2:00 PM'
      },
      {
        name: 'Flash',
        usedPercent: 80,
        windowMinutes: 300,
        resetsAt: 2000,
        resetDescription: '3:00 PM'
      }
    ]
    const summary = deriveSessionSummary(buckets)
    expect(summary!.resetsAt).toBe(2000)
    expect(summary!.resetDescription).toBe('3:00 PM')
  })
})

describe('fetchGeminiRateLimits', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-24T12:00:00.000Z'))
    readFileMock.mockReset()
    netFetchMock.mockReset()
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
    expect(result.buckets![0].name).toBe('Unknown (gemini-experimental)')
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

  it('returns error when auth.json token is expired', async () => {
    setupAuthJsonGoogleExpired()

    const result = await fetchGeminiRateLimits()

    expect(result.status).toBe('error')
    expect(result.error).toContain('Token refresh unavailable for auth.json source')
    expect(result.session).toBeNull()
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('returns error when auth.json refresh fails', async () => {
    setupAuthJsonGoogleExpired()

    const result = await fetchGeminiRateLimits()

    expect(result.status).toBe('error')
    expect(result.error).toContain('Token refresh unavailable for auth.json source')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
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

  it('returns error when auth.json quota fetch returns 401', async () => {
    setupAuthJsonGoogleValid()
    netFetchMock.mockResolvedValueOnce(makeResponse('Unauthorized', 401))

    const result = await fetchGeminiRateLimits()

    expect(result.status).toBe('error')
    expect(result.error).toContain('Token refresh unavailable for auth.json source')
    expect(result.session).toBeNull()
  })

  it('returns error when auth.json quota fetch returns 401 repeatedly', async () => {
    setupAuthJsonGoogleValid()
    netFetchMock.mockResolvedValueOnce(makeResponse('Unauthorized', 401))

    const result = await fetchGeminiRateLimits()

    expect(result.status).toBe('error')
    expect(result.error).toContain('Token refresh unavailable for auth.json source')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
  })

  it('returns error when auth.json quota fetch returns 401 without retry path', async () => {
    setupAuthJsonGoogleValid()
    netFetchMock.mockResolvedValueOnce(makeResponse('Unauthorized', 401))

    const result = await fetchGeminiRateLimits()

    expect(result.status).toBe('error')
    expect(result.error).toContain('Token refresh unavailable for auth.json source')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
  })
})
