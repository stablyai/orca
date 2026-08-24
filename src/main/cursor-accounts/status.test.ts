import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getCursorAccountStatus } from './status'
import { isCursorAccessTokenFresh, readCursorAuthSession } from '../rate-limits/cursor-auth'

vi.mock('../rate-limits/cursor-auth', () => ({
  isCursorAccessTokenFresh: vi.fn(),
  readCursorAuthSession: vi.fn()
}))

describe('getCursorAccountStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isCursorAccessTokenFresh).mockReturnValue(true)
  })

  it('reports unsigned status when the Cursor auth token is missing', () => {
    vi.mocked(readCursorAuthSession).mockReturnValue({ status: 'missing' })

    expect(getCursorAccountStatus()).toEqual({
      signedIn: false,
      email: null,
      userId: null,
      tokenFresh: false,
      error: null
    })
  })

  it('reports auth read errors without exposing token fields', () => {
    vi.mocked(readCursorAuthSession).mockReturnValue({
      status: 'error',
      error: 'Cursor sign-in token is invalid'
    })

    expect(getCursorAccountStatus()).toEqual({
      signedIn: false,
      email: null,
      userId: null,
      tokenFresh: false,
      error: 'Cursor sign-in token is invalid'
    })
  })

  it('returns non-secret signed-in metadata and freshness', () => {
    vi.mocked(readCursorAuthSession).mockReturnValue({
      status: 'ok',
      session: {
        accessToken: 'secret-token',
        email: 'dev@example.com',
        userId: 'user-1',
        expiresAtMs: null
      }
    })
    vi.mocked(isCursorAccessTokenFresh).mockReturnValue(false)

    const status = getCursorAccountStatus()

    expect(status).toEqual({
      signedIn: true,
      email: 'dev@example.com',
      userId: 'user-1',
      tokenFresh: false,
      error: null
    })
    expect(JSON.stringify(status)).not.toContain('secret-token')
  })
})
