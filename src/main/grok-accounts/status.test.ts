import { describe, expect, it, vi } from 'vitest'
import { getGrokAccountStatus } from './status'
import { isGrokAccessTokenFresh } from '../rate-limits/grok-auth'

vi.mock('../rate-limits/grok-auth', () => ({
  isGrokAccessTokenFresh: vi.fn()
}))

describe('getGrokAccountStatus', () => {
  it('reports unsigned status when the Grok auth file is missing', () => {
    expect(getGrokAccountStatus({ status: 'missing' })).toEqual({
      signedIn: false,
      email: null,
      teamId: null,
      tokenFresh: false,
      error: null
    })
  })

  it('reports auth read errors without exposing token fields', () => {
    expect(
      getGrokAccountStatus({
        status: 'error',
        error: 'Grok auth file is invalid'
      })
    ).toEqual({
      signedIn: false,
      email: null,
      teamId: null,
      tokenFresh: false,
      error: 'Grok auth file is invalid'
    })
  })

  it('returns non-secret signed-in metadata and freshness', () => {
    vi.mocked(isGrokAccessTokenFresh).mockReturnValue(false)
    const status = getGrokAccountStatus({
      status: 'ok',
      session: {
        accessToken: 'secret-token',
        email: 'dev@example.com',
        teamId: 'team-1',
        userId: 'user-1',
        expiresAtMs: null,
        oidcClientId: 'client-1'
      }
    })

    expect(status).toEqual({
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
