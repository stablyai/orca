import { afterEach, describe, expect, it, vi } from 'vitest'

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

describe('cursor-auth', () => {
  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('node:fs')
    vi.doUnmock('../sqlite/sync-database')
  })

  it('parses user id and expiry from a JWT access token', async () => {
    const token = makeJwt({ sub: 'auth0|cursor-user-123', exp: 4_102_444_800 })
    const { sessionFromAccessToken, isCursorAccessTokenFresh } = await import('./cursor-auth')

    const session = sessionFromAccessToken(token, 'dev@example.com')
    expect(session).toEqual({
      accessToken: token,
      userId: 'cursor-user-123',
      email: 'dev@example.com',
      expiresAtMs: 4_102_444_800_000
    })
    expect(isCursorAccessTokenFresh(session!)).toBe(true)
  })

  it('builds the Cursor session cookie header', async () => {
    const token = makeJwt({ sub: 'auth0|user-abc' })
    const { buildCursorCookieHeader, sessionFromAccessToken } = await import('./cursor-auth')
    const session = sessionFromAccessToken(token)
    expect(session).not.toBeNull()
    expect(buildCursorCookieHeader(session!)).toBe(
      `WorkosCursorSessionToken=user-abc%3A%3A${token}`
    )
  })

  it('returns missing when the Cursor state database does not exist', async () => {
    vi.doMock('node:fs', () => ({
      existsSync: vi.fn(() => false)
    }))
    const { readCursorAuthSession } = await import('./cursor-auth')

    expect(readCursorAuthSession()).toEqual({ status: 'missing' })
  })

  it('returns missing when the state database has no access token row', async () => {
    vi.doMock('node:fs', () => ({
      existsSync: vi.fn(() => true)
    }))
    vi.doMock('../sqlite/sync-database', () => ({
      default: class MockDatabase {
        prepare() {
          return { get: () => undefined }
        }
        close() {}
      }
    }))
    const { readCursorAuthSession } = await import('./cursor-auth')

    expect(readCursorAuthSession()).toEqual({ status: 'missing' })
  })
})
