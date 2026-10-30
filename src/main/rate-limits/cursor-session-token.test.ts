import { describe, expect, it } from 'vitest'
import {
  cursorSessionCookie,
  isCursorSessionTokenExpired,
  parseCursorSessionToken
} from './cursor-session-token'

type JwtSegment = Record<string, unknown>

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: JwtSegment): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'RS256' })}.${encode(payload)}.signature`
}

describe('parseCursorSessionToken', () => {
  it('reads the WorkOS subject and expiry from a cursor-agent session token', () => {
    const token = parseCursorSessionToken(
      jwt({ sub: 'auth0|user_01ABC', exp: 1_800_000_000, aud: 'https://cursor.com' })
    )
    expect(token?.subject).toBe('auth0|user_01ABC')
    expect(token?.expiresAtMs).toBe(1_800_000_000_000)
  })

  it('rejects a token without a subject, which cannot address the dashboard', () => {
    expect(parseCursorSessionToken(jwt({ exp: 1_800_000_000 }))).toBeNull()
  })

  it('rejects blank and malformed tokens instead of throwing', () => {
    expect(parseCursorSessionToken('   ')).toBeNull()
    expect(parseCursorSessionToken('not-a-jwt')).toBeNull()
    expect(parseCursorSessionToken('a.!!!.c')).toBeNull()
  })

  it('leaves expiry null when the token omits exp', () => {
    expect(parseCursorSessionToken(jwt({ sub: 'auth0|user_1' }))?.expiresAtMs).toBeNull()
  })
})

describe('isCursorSessionTokenExpired', () => {
  const token = parseCursorSessionToken(jwt({ sub: 'auth0|user_1', exp: 2_000 }))

  it('reports a lapsed session', () => {
    expect(isCursorSessionTokenExpired(token!, 2_000_001)).toBe(true)
  })

  it('reports a live session', () => {
    expect(isCursorSessionTokenExpired(token!, 1_999_999)).toBe(false)
  })

  it('never expires a token with no exp claim', () => {
    const noExpiry = parseCursorSessionToken(jwt({ sub: 'auth0|user_1' }))
    expect(isCursorSessionTokenExpired(noExpiry!, Number.MAX_SAFE_INTEGER)).toBe(false)
  })
})

describe('cursorSessionCookie', () => {
  it('escapes the subject and joins it to the token the way the dashboard does', () => {
    const token = parseCursorSessionToken(jwt({ sub: 'auth0|user_01ABC' }))
    expect(cursorSessionCookie(token!)).toBe(
      `WorkosCursorSessionToken=auth0%7Cuser_01ABC%3A%3A${token!.raw}`
    )
  })
})
