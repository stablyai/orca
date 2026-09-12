import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeResponse } from './gemini-usage-fetcher.test-fixtures'

const {
  readSessionMock,
  extractClientsMock,
  refreshMock,
  saveMock,
  readProjectMock,
  netFetchMock
} = vi.hoisted(() => ({
  readSessionMock: vi.fn(),
  extractClientsMock: vi.fn(),
  refreshMock: vi.fn(),
  saveMock: vi.fn(),
  readProjectMock: vi.fn(),
  netFetchMock: vi.fn()
}))

vi.mock('./antigravity-oauth-sources', () => ({
  readAntigravityAuthSession: readSessionMock,
  isAntigravityAccessTokenFresh: (session: {
    accessToken: string | null
    expiresAtMs: number | null
  }) =>
    Boolean(session.accessToken) &&
    (session.expiresAtMs === null || session.expiresAtMs > Date.now() + 5 * 60 * 1000),
  isAntigravitySessionUsable: vi.fn(),
  saveAntigravityCredentials: saveMock,
  readAntigravityDefaultProjectId: readProjectMock
}))

vi.mock('./antigravity-cli-oauth-extractor', () => ({
  extractAntigravityOAuthClients: extractClientsMock
}))

vi.mock('./gemini-oauth-sources', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    refreshAccessToken: refreshMock
  }
})

vi.mock('electron', () => ({ net: { fetch: netFetchMock } }))

import { fetchAntigravityRateLimits } from './antigravity-usage-fetcher'

const quotaSummary = {
  groups: [
    {
      displayName: 'Gemini Models',
      buckets: [
        {
          bucketId: 'gemini-weekly',
          window: 'weekly',
          resetTime: '2099-01-10T18:00:00Z',
          remainingFraction: 0.2
        },
        {
          bucketId: 'gemini-5h',
          window: '5h',
          resetTime: '2099-01-08T14:00:00Z',
          remainingFraction: 0.5
        }
      ]
    }
  ]
}

const freshSession = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAtMs: Date.parse('2099-01-01T00:00:00.000Z'),
  authMethod: 'consumer' as const,
  email: 'dev@example.com'
}

describe('fetchAntigravityRateLimits', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-08T12:00:00.000Z'))
    readSessionMock.mockReset()
    extractClientsMock.mockReset()
    refreshMock.mockReset()
    saveMock.mockReset()
    readProjectMock.mockReset()
    netFetchMock.mockReset()
    saveMock.mockResolvedValue(undefined)
    readProjectMock.mockResolvedValue('default-cli-project')
    extractClientsMock.mockResolvedValue([
      { clientId: 'client-1.apps.googleusercontent.com', clientSecret: 'GOCSPX-test' }
    ])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns unavailable when the Antigravity CLI is not signed in', async () => {
    readSessionMock.mockReturnValue({ status: 'missing' })
    const result = await fetchAntigravityRateLimits()
    expect(result.status).toBe('unavailable')
    expect(result.error).toContain('not signed in')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('reads quota from a fresh Antigravity session', async () => {
    readSessionMock.mockReturnValue({ status: 'ok', session: freshSession })
    netFetchMock.mockResolvedValue(makeResponse(quotaSummary))

    const result = await fetchAntigravityRateLimits()

    expect(result.status).toBe('ok')
    expect(result.provider).toBe('antigravity')
    expect(result.weekly?.usedPercent).toBe(80)
    expect(result.session?.usedPercent).toBe(50)
    expect(result.buckets).toHaveLength(2)
    expect(extractClientsMock).not.toHaveBeenCalled()
    expect(String(netFetchMock.mock.calls[0]?.[0])).toContain('daily-cloudcode-pa')
    expect(String(netFetchMock.mock.calls[0]?.[0])).toContain('retrieveUserQuotaSummary')
    expect(netFetchMock.mock.calls[0]?.[1]?.headers['User-Agent']).toBe('antigravity')
  })

  it('refreshes an expired access token before reading quota', async () => {
    readSessionMock.mockReturnValue({
      status: 'ok',
      session: { ...freshSession, expiresAtMs: Date.parse('2026-09-05T00:00:00.000Z') }
    })
    refreshMock.mockResolvedValue({
      accessToken: 'new-access',
      newRefreshToken: null,
      expiresIn: 3600
    })
    netFetchMock.mockResolvedValue(makeResponse(quotaSummary))

    const result = await fetchAntigravityRateLimits()

    expect(result.status).toBe('ok')
    expect(saveMock).toHaveBeenCalled()
    expect(netFetchMock.mock.calls[0]?.[1]?.headers.Authorization).toBe('Bearer new-access')
  })

  it('retries quota after a 401 by refreshing the access token', async () => {
    readSessionMock.mockReturnValue({ status: 'ok', session: freshSession })
    refreshMock.mockResolvedValue({
      accessToken: 'new-access',
      newRefreshToken: null,
      expiresIn: 3600
    })
    netFetchMock
      .mockResolvedValueOnce(makeResponse({ error: { message: 'unauthorized' } }, 401))
      .mockResolvedValueOnce(makeResponse(quotaSummary))

    const result = await fetchAntigravityRateLimits()

    expect(result.status).toBe('ok')
    expect(result.weekly?.usedPercent).toBe(80)
    expect(netFetchMock.mock.calls[1]?.[1]?.headers.Authorization).toBe('Bearer new-access')
  })

  it('treats a Code Assist license refusal as unavailable, not a refresh failure', async () => {
    readSessionMock.mockReturnValue({ status: 'ok', session: freshSession })
    netFetchMock.mockResolvedValue(
      makeResponse(
        {
          error: {
            message:
              'You do not have a valid license of this product. Please contact your administrator'
          }
        },
        403
      )
    )

    const result = await fetchAntigravityRateLimits()

    expect(result.status).toBe('unavailable')
    expect(result.error).toContain('signed in')
    expect(result.error).not.toContain('Refresh failed')
    expect(netFetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports a stale session when the access token cannot be refreshed', async () => {
    readSessionMock.mockReturnValue({
      status: 'ok',
      session: { ...freshSession, expiresAtMs: Date.parse('2026-09-05T00:00:00.000Z') }
    })
    extractClientsMock.mockResolvedValue([])

    const result = await fetchAntigravityRateLimits()

    expect(result.status).toBe('error')
    expect(result.error).toContain('expired')
    expect(netFetchMock).not.toHaveBeenCalled()
  })
})
