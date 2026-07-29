import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getGrokAccountStatus } from './status'
import { isGrokAccessTokenFresh, readGrokAuthSession } from '../rate-limits/grok-auth'

vi.mock('../rate-limits/grok-auth', () => ({
  isGrokAccessTokenFresh: vi.fn(),
  readGrokAuthSession: vi.fn()
}))

describe('getGrokAccountStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isGrokAccessTokenFresh).mockReturnValue(true)
  })

  it('reports unsigned status when the Grok auth file is missing', () => {
    vi.mocked(readGrokAuthSession).mockReturnValue({ status: 'missing' })

    expect(getGrokAccountStatus()).toEqual({
      signedIn: false,
      email: null,
      teamId: null,
      tokenFresh: false,
      error: null
    })
  })

  it('reports auth read errors without exposing token fields', () => {
    vi.mocked(readGrokAuthSession).mockReturnValue({
      status: 'error',
      error: 'Grok auth file is invalid'
    })

    expect(getGrokAccountStatus()).toEqual({
      signedIn: false,
      email: null,
      teamId: null,
      tokenFresh: false,
      error: 'Grok auth file is invalid'
    })
  })

  it('returns non-secret signed-in metadata and freshness', () => {
    vi.mocked(readGrokAuthSession).mockReturnValue({
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
    vi.mocked(isGrokAccessTokenFresh).mockReturnValue(false)

    const status = getGrokAccountStatus()

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
