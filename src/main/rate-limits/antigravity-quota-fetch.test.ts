import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findCredentialMock, fetchQuotaMock } = vi.hoisted(() => ({
  findCredentialMock: vi.fn(),
  fetchQuotaMock: vi.fn()
}))

vi.mock('./antigravity-credential-hosts', () => ({
  findAntigravityCredential: findCredentialMock
}))
vi.mock('./antigravity-cloud-code-api', () => ({ fetchAntigravityQuota: fetchQuotaMock }))

import { fetchAntigravityRateLimits } from './antigravity-quota-fetch'

const FOUND = {
  status: 'ok',
  found: {
    credential: { accessToken: 'access-1', expiresAt: null },
    hostId: 'ssh:box',
    hostLabel: 'Dev box'
  }
}

const GROUPS = [
  {
    displayName: 'Gemini Models',
    buckets: [
      {
        displayName: 'Weekly Limit Remaining',
        window: 'weekly',
        resetTime: '2026-09-11T05:00:13Z',
        remainingFraction: 0.8
      },
      {
        displayName: 'Five Hour Limit Remaining',
        window: '5h',
        resetTime: '2026-09-07T08:00:13Z',
        remainingFraction: 0.5
      }
    ]
  }
]

describe('fetchAntigravityRateLimits', () => {
  beforeEach(() => {
    findCredentialMock.mockReset().mockResolvedValue(FOUND)
    fetchQuotaMock.mockReset().mockResolvedValue({ status: 'ok', groups: GROUPS })
  })

  it('publishes both windows and names the host the sign-in came from', async () => {
    const result = await fetchAntigravityRateLimits()
    expect(result).toMatchObject({
      provider: 'antigravity',
      status: 'ok',
      error: null,
      session: { usedPercent: 50, windowMinutes: 300 },
      weekly: { usedPercent: 20, windowMinutes: 10080 },
      usageMetadata: { source: 'oauth', credentialSource: 'Dev box' }
    })
    expect(result.buckets).toHaveLength(2)
  })

  it('uses the stored access token as-is', async () => {
    await fetchAntigravityRateLimits()
    expect(fetchQuotaMock).toHaveBeenCalledWith('access-1', undefined)
  })

  it('asks the user to sign in when no host holds a credential', async () => {
    findCredentialMock.mockResolvedValue({ status: 'missing' })
    const result = await fetchAntigravityRateLimits()
    expect(result).toMatchObject({
      status: 'unavailable',
      usageMetadata: { failureKind: 'missing-credentials' }
    })
    expect(fetchQuotaMock).not.toHaveBeenCalled()
  })

  it('names the host whose sign-in expired', async () => {
    findCredentialMock.mockResolvedValue({ status: 'expired', hostLabel: 'Dev box' })
    const result = await fetchAntigravityRateLimits()
    expect(result.status).toBe('unavailable')
    expect(result.error).toContain('Dev box')
    expect(result.usageMetadata?.failureKind).toBe('stale-token')
  })

  it('does not report a lost remote host as a missing sign-in', async () => {
    findCredentialMock.mockResolvedValue({
      status: 'unverifiable',
      hostLabel: 'Dev box',
      message: 'Remote host did not answer.'
    })
    const result = await fetchAntigravityRateLimits()
    expect(result.status).toBe('error')
    expect(result.error).not.toMatch(/sign in to/i)
    expect(result.usageMetadata?.failureKind).toBe('network')
  })

  it('separates a rejected token from an account without a grant', async () => {
    fetchQuotaMock.mockResolvedValue({ status: 'unauthorized' })
    expect((await fetchAntigravityRateLimits()).usageMetadata?.failureKind).toBe('stale-token')

    fetchQuotaMock.mockResolvedValue({ status: 'not-entitled' })
    const notEntitled = await fetchAntigravityRateLimits()
    expect(notEntitled.status).toBe('unavailable')
    expect(notEntitled.usageMetadata?.failureKind).toBe('usage-unavailable')
  })

  it('surfaces a transport error without claiming quota is empty', async () => {
    fetchQuotaMock.mockResolvedValue({ status: 'error', message: 'Antigravity quota fetch failed' })
    const result = await fetchAntigravityRateLimits()
    expect(result).toMatchObject({ status: 'error', usageMetadata: { failureKind: 'server' } })
  })

  it('reports a response with no usable window as a parse failure', async () => {
    fetchQuotaMock.mockResolvedValue({ status: 'ok', groups: [] })
    expect((await fetchAntigravityRateLimits()).usageMetadata?.failureKind).toBe('parse')
  })

  it('forwards the caller abort signal', async () => {
    const controller = new AbortController()
    await fetchAntigravityRateLimits(controller.signal)
    expect(fetchQuotaMock).toHaveBeenCalledWith('access-1', controller.signal)
  })
})
