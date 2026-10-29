import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getGrokAccountStatus } from './status'
import { getGrokAuthSnapshot } from '../rate-limits/grok-auth-snapshot'
import { isGrokAccessTokenFresh } from '../rate-limits/grok-auth'

vi.mock('../rate-limits/grok-auth', () => ({
  isGrokAccessTokenFresh: vi.fn()
}))

vi.mock('../rate-limits/grok-auth-snapshot', () => ({ getGrokAuthSnapshot: vi.fn() }))

describe('getGrokAccountStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isGrokAccessTokenFresh).mockReturnValue(true)
  })

  it('reports auth read errors without exposing token fields', () => {
    vi.mocked(getGrokAuthSnapshot).mockReturnValue({
      value: null,
      stale: true,
      age: null,
      availability: 'unavailable'
    })

    expect(getGrokAccountStatus()).toMatchObject({
      signedIn: false,
      email: null,
      teamId: null,
      tokenFresh: false,
      error: 'Unable to read Grok auth file'
    })
  })

  it('returns non-secret signed-in metadata and freshness', () => {
    vi.mocked(getGrokAuthSnapshot).mockReturnValue({
      stale: false,
      age: 0,
      availability: 'ready',
      value: {
        accessToken: 'secret-token',
        email: 'dev@example.com',
        teamId: 'team-1',
        userId: 'user-1',
        expiresAtMs: null,
        oidcClientId: 'client-1'
      }
    })
    vi.mocked(isGrokAccessTokenFresh).mockReturnValue(false)

    const status = getGrokAccountStatus()

    expect(status).toMatchObject({
      signedIn: true,
      email: 'dev@example.com',
      teamId: 'team-1',
      tokenFresh: false,
      error: null
    })
    expect(JSON.stringify(status)).not.toContain('secret-token')
    expect(JSON.stringify(status)).not.toContain('client-1')
  })
})
