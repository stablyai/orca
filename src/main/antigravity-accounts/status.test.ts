import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAntigravityAccountStatus } from './status'
import {
  isAntigravitySessionUsable,
  readAntigravityAuthSession
} from '../rate-limits/antigravity-oauth-sources'

vi.mock('../rate-limits/antigravity-oauth-sources', () => ({
  isAntigravitySessionUsable: vi.fn(),
  readAntigravityAuthSession: vi.fn()
}))

describe('getAntigravityAccountStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isAntigravitySessionUsable).mockReturnValue(true)
  })

  it('reports unsigned status when the Antigravity token file is missing', () => {
    vi.mocked(readAntigravityAuthSession).mockReturnValue({ status: 'missing' })

    expect(getAntigravityAccountStatus()).toEqual({
      signedIn: false,
      email: null,
      tokenFresh: false,
      error: null
    })
  })

  it('reports auth read errors without exposing token fields', () => {
    vi.mocked(readAntigravityAuthSession).mockReturnValue({
      status: 'error',
      error: 'Antigravity auth file is invalid'
    })

    expect(getAntigravityAccountStatus()).toEqual({
      signedIn: false,
      email: null,
      tokenFresh: false,
      error: 'Antigravity auth file is invalid'
    })
  })

  it('returns non-secret signed-in metadata', () => {
    vi.mocked(readAntigravityAuthSession).mockReturnValue({
      status: 'ok',
      session: {
        accessToken: 'secret-token',
        refreshToken: 'secret-refresh',
        expiresAtMs: Date.parse('2099-01-01T00:00:00.000Z'),
        authMethod: 'consumer',
        email: 'dev@example.com'
      }
    })
    vi.mocked(isAntigravitySessionUsable).mockReturnValue(true)

    const status = getAntigravityAccountStatus()

    expect(status).toEqual({
      signedIn: true,
      email: 'dev@example.com',
      tokenFresh: true,
      error: null
    })
    expect(JSON.stringify(status)).not.toContain('secret-token')
    expect(JSON.stringify(status)).not.toContain('secret-refresh')
  })
})
