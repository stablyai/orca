import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getTokenMock, invalidateTokenMock, netFetchMock, MockAntigravityAuthError } = vi.hoisted(
  () => {
    class HoistedMockAntigravityAuthError extends Error {
      readonly failureKind: string
      readonly status: number | null

      constructor(message: string, failureKind: string, status: number | null = null) {
        super(message)
        this.name = 'AntigravityAuthError'
        this.failureKind = failureKind
        this.status = status
      }
    }
    return {
      getTokenMock: vi.fn(),
      invalidateTokenMock: vi.fn(),
      netFetchMock: vi.fn(),
      MockAntigravityAuthError: HoistedMockAntigravityAuthError
    }
  }
)

vi.mock('./antigravity-auth', () => ({
  AntigravityAuthError: MockAntigravityAuthError,
  getAntigravityAccessToken: getTokenMock,
  invalidateAntigravityAccessToken: invalidateTokenMock
}))

vi.mock('electron', () => ({ net: { fetch: netFetchMock } }))

import {
  fetchAntigravityRateLimits,
  parseAntigravityQuotaBuckets
} from './antigravity-usage-fetcher'

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body
  } as Response
}

function token(accessToken = 'access-token') {
  return {
    accessToken,
    credentialSource: 'official-keychain' as const,
    sourceKey: 'official-keychain:/tmp/test'
  }
}

const quotaGroups = [
  {
    buckets: [
      {
        bucketId: 'gemini-weekly',
        remainingFraction: 0.75,
        resetTime: '2026-08-04T17:38:47Z'
      },
      {
        bucketId: 'gemini-5h',
        remainingFraction: 0.9,
        resetTime: '2026-08-01T18:30:17Z'
      }
    ]
  },
  {
    buckets: [
      { bucketId: '3p-weekly', remainingFraction: 0.5, resetTime: '2026-08-06T13:00:53Z' },
      { bucketId: '3p-5h', remainingFraction: 1, resetTime: '2026-08-01T18:37:49Z' }
    ]
  }
]

describe('fetchAntigravityRateLimits', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-01T11:00:00.000Z'))
    getTokenMock.mockReset()
    invalidateTokenMock.mockReset()
    netFetchMock.mockReset()
    getTokenMock.mockResolvedValue(token())
    netFetchMock.mockImplementation((url: string) => {
      if (url.includes('loadCodeAssist')) {
        return Promise.resolve(response({ cloudaicompanionProject: 'project-123' }))
      }
      if (url.includes('retrieveUserQuotaSummary')) {
        return Promise.resolve(response({ groups: quotaGroups }))
      }
      return Promise.resolve(response({}, 404))
    })
  })

  it('uses Antigravity metadata and maps all current quota identities', async () => {
    const signal = new AbortController().signal
    const result = await fetchAntigravityRateLimits({ signal })

    expect(result.status).toBe('ok')
    expect(result.provider).toBe('antigravity')
    expect(result.session?.usedPercent).toBe(10)
    expect(result.weekly?.usedPercent).toBe(25)
    expect(result.buckets?.map((bucket) => bucket.name)).toEqual([
      'Antigravity 5h',
      'Antigravity weekly',
      '3-party 5h',
      '3-party weekly'
    ])
    expect(getTokenMock).toHaveBeenCalledWith(expect.objectContaining({ signal }))

    const loadCall = netFetchMock.mock.calls.find((call) =>
      String(call[0]).includes('loadCodeAssist')
    )
    expect(loadCall).toBeDefined()
    const loadBody = JSON.parse((loadCall![1] as RequestInit).body as string) as {
      metadata: { platform: string; ideType: string; pluginType: string }
    }
    expect(loadBody.metadata).toEqual({
      ideType: 'ANTIGRAVITY',
      platform: 'PLATFORM_UNSPECIFIED',
      pluginType: 'GEMINI'
    })
    expect((loadCall![1] as RequestInit).headers).toEqual(
      expect.objectContaining({
        Authorization: 'Bearer access-token',
        'Client-Metadata': JSON.stringify(loadBody.metadata)
      })
    )
  })

  it('deduplicates by bucket identity and ignores unknown or invalid buckets', () => {
    const parsed = parseAntigravityQuotaBuckets({
      groups: [
        {
          buckets: [
            { bucketId: 'gemini-5h', remainingFraction: 0.8, resetTime: '2026-08-01T12:00:00Z' },
            { bucketId: 'gemini-5h', remainingFraction: 0.2, resetTime: '2026-08-01T12:00:00Z' },
            { bucketId: 'unknown-window', remainingFraction: 0.1 },
            { bucketId: '3p-5h', remainingFraction: Number.NaN }
          ]
        }
      ]
    })

    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.id).toBe('gemini-5h')
    expect(parsed[0]?.bucket.usedPercent).toBe(20)
  })

  it('does not turn an empty successful summary into an ok result or a fallback storm', async () => {
    netFetchMock.mockImplementation((url: string) => {
      if (url.includes('loadCodeAssist')) {
        return Promise.resolve(response({ cloudaicompanionProject: 'project-123' }))
      }
      if (url.includes('retrieveUserQuotaSummary')) {
        return Promise.resolve(response({ groups: [] }))
      }
      return Promise.resolve(response({ buckets: quotaGroups[0].buckets }))
    })

    const result = await fetchAntigravityRateLimits()

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('usage-unavailable')
    expect(netFetchMock).toHaveBeenCalledTimes(2)
    expect(
      netFetchMock.mock.calls.some((call) =>
        String(call[0]).endsWith('v1internal:retrieveUserQuota')
      )
    ).toBe(false)
  })

  it('uses the legacy endpoint only when the summary endpoint is unsupported', async () => {
    netFetchMock.mockImplementation((url: string) => {
      if (url.includes('loadCodeAssist')) {
        return Promise.resolve(response({ cloudaicompanionProject: 'project-123' }))
      }
      if (url.includes('retrieveUserQuotaSummary')) {
        return Promise.resolve(response({}, 404))
      }
      return Promise.resolve(response({ buckets: [quotaGroups[0].buckets[1]] }))
    })

    const result = await fetchAntigravityRateLimits()

    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(10)
    expect(netFetchMock).toHaveBeenCalledTimes(3)
  })

  it('reports an empty legacy response with the summary endpoint failure context', async () => {
    netFetchMock.mockImplementation((url: string) => {
      if (url.includes('loadCodeAssist')) {
        return Promise.resolve(response({ cloudaicompanionProject: 'project-123' }))
      }
      if (url.includes('retrieveUserQuotaSummary')) {
        return Promise.resolve(response({}, 404))
      }
      return Promise.resolve(response({ groups: [] }))
    })

    const result = await fetchAntigravityRateLimits()

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('usage-unavailable')
    expect(netFetchMock).toHaveBeenCalledTimes(3)
  })

  it('refreshes once after a quota API 401 or 403', async () => {
    let loadCalls = 0
    netFetchMock.mockImplementation((url: string) => {
      if (url.includes('loadCodeAssist')) {
        loadCalls += 1
        return Promise.resolve(
          loadCalls === 1
            ? response({ error: 'Unauthenticated' }, 401)
            : response({ cloudaicompanionProject: 'project-123' })
        )
      }
      return Promise.resolve(response({ groups: quotaGroups }))
    })
    getTokenMock
      .mockResolvedValueOnce(token('old-access-token'))
      .mockResolvedValueOnce(token('new-access-token'))

    const result = await fetchAntigravityRateLimits()

    expect(result.status).toBe('ok')
    expect(invalidateTokenMock).toHaveBeenCalledWith('official-keychain:/tmp/test')
    expect(getTokenMock).toHaveBeenNthCalledWith(2, { forceRefresh: true })
    expect(
      netFetchMock.mock.calls.some(
        (call) =>
          (call[1] as RequestInit).headers && JSON.stringify(call[1]).includes('new-access-token')
      )
    ).toBe(true)

    netFetchMock.mockReset()
    let forbiddenLoadCalls = 0
    netFetchMock.mockImplementation((url: string) => {
      if (url.includes('loadCodeAssist')) {
        forbiddenLoadCalls += 1
        return Promise.resolve(
          forbiddenLoadCalls === 1
            ? response({ error: 'Forbidden' }, 403)
            : response({ cloudaicompanionProject: 'project-123' })
        )
      }
      return Promise.resolve(response({ groups: quotaGroups }))
    })
    getTokenMock.mockReset()
    getTokenMock
      .mockResolvedValueOnce(token('old-forbidden-token'))
      .mockResolvedValueOnce(token('new-forbidden-token'))
    const forbidden = await fetchAntigravityRateLimits()
    expect(forbidden.status).toBe('ok')
    expect(getTokenMock).toHaveBeenNthCalledWith(2, { forceRefresh: true })
    expect(
      netFetchMock.mock.calls.some(
        (call) =>
          (call[1] as RequestInit).headers &&
          JSON.stringify(call[1]).includes('new-forbidden-token')
      )
    ).toBe(true)
  })

  it('reports missing credentials as unavailable', async () => {
    getTokenMock.mockRejectedValue(
      new MockAntigravityAuthError('Antigravity credentials not found', 'missing-credentials')
    )

    const result = await fetchAntigravityRateLimits()

    expect(result.status).toBe('unavailable')
    expect(result.usageMetadata?.failureKind).toBe('missing-credentials')
    expect(netFetchMock).not.toHaveBeenCalled()
  })
})
