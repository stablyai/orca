import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getGrokAccountStatus } from './status'
import { isGrokAccessTokenFresh } from '../rate-limits/grok-auth'
import { getGrokAuthSnapshot } from '../rate-limits/grok-auth-snapshot'

vi.mock('../rate-limits/grok-auth', () => ({
  isGrokAccessTokenFresh: vi.fn()
}))

vi.mock('../rate-limits/grok-auth-snapshot', () => ({
  getGrokAuthSnapshot: vi.fn()
}))

describe('getGrokAccountStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isGrokAccessTokenFresh).mockReturnValue(true)
  })

  it('reports unsigned status when the Grok auth file is missing', () => {
    vi.mocked(getGrokAuthSnapshot).mockReturnValue({
      value: null,
      stale: false,
      age: 0,
      availability: 'missing'
    })

    expect(getGrokAccountStatus()).toEqual({
      signedIn: false,
      email: null,
      teamId: null,
      tokenFresh: false,
      error: null,
      value: null,
      stale: false,
      age: 0,
      availability: 'missing'
    })
  })

  it('reports auth read errors without exposing token fields', () => {
    vi.mocked(getGrokAuthSnapshot).mockReturnValue({
      value: null,
      stale: true,
      age: null,
      availability: 'unavailable'
    })

    expect(getGrokAccountStatus()).toEqual({
      signedIn: false,
      email: null,
      teamId: null,
      tokenFresh: false,
      error: 'Unable to read Grok auth file',
      value: null,
      stale: true,
      age: null,
      availability: 'unavailable'
    })
  })

  it('returns non-secret signed-in metadata and freshness', () => {
    vi.mocked(getGrokAuthSnapshot).mockReturnValue({
      value: {
        accessToken: 'secret-token',
        email: 'dev@example.com',
        teamId: 'team-1',
        userId: 'user-1',
        expiresAtMs: null,
        oidcClientId: 'client-1'
      },
      stale: false,
      age: 10,
      availability: 'ready'
    })
    vi.mocked(isGrokAccessTokenFresh).mockReturnValue(false)

    const status = getGrokAccountStatus()

    expect(status).toEqual({
      signedIn: true,
      email: 'dev@example.com',
      teamId: 'team-1',
      tokenFresh: false,
      error: null,
      value: {
        signedIn: true,
        email: 'dev@example.com',
        teamId: 'team-1',
        tokenFresh: false
      },
      stale: false,
      age: 10,
      availability: 'ready'
    })
    expect(JSON.stringify(status)).not.toContain('secret-token')
    expect(JSON.stringify(status)).not.toContain('client-1')
  })
})
