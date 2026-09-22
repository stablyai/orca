import { afterEach, describe, expect, it, vi } from 'vitest'
import { ANTIGRAVITY_NOT_SIGNED_IN, fetchAntigravityRateLimits } from './antigravity-usage-fetcher'

const { readAuth, refreshBundle, netFetch } = vi.hoisted(() => ({
  readAuth: vi.fn(),
  refreshBundle: vi.fn(),
  netFetch: vi.fn()
}))

vi.mock('./antigravity-oauth-sources', () => ({
  isAntigravityAccessTokenFresh: (session: {
    accessToken: string | null
    expiresAtMs: number | null
  }) => Boolean(session.accessToken),
  readAntigravityAuthSession: readAuth
}))

vi.mock('./gemini-oauth-sources', () => ({
  tryRefreshTokenFromBundle: refreshBundle
}))

vi.mock('electron', () => ({
  net: { fetch: netFetch }
}))

describe('fetchAntigravityRateLimits', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns unavailable when Antigravity is not signed in', async () => {
    readAuth.mockResolvedValue({ status: 'missing' })
    const result = await fetchAntigravityRateLimits()
    expect(result.status).toBe('unavailable')
    expect(result.error).toBe(ANTIGRAVITY_NOT_SIGNED_IN)
    expect(netFetch).not.toHaveBeenCalled()
  })

  it('maps a native quota summary to Antigravity usage windows', async () => {
    readAuth.mockResolvedValue({
      status: 'ok',
      session: {
        accessToken: 'ya29.access',
        refreshToken: '1//refresh',
        expiresAtMs: Date.now() + 60_000,
        email: null
      }
    })
    netFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        groups: [
          {
            displayName: 'Gemini',
            buckets: [{ bucketId: '5h', remainingFraction: 0.5 }]
          }
        ]
      })
    })

    const result = await fetchAntigravityRateLimits()
    expect(result.status).toBe('ok')
    expect(result.provider).toBe('antigravity')
    expect(result.session?.usedPercent).toBe(50)
    expect(result.error).toBeNull()
  })
})
