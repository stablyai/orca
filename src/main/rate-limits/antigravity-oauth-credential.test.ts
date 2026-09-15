import { describe, expect, it } from 'vitest'
import {
  isAntigravityCredentialExpired,
  parseAntigravityOAuthCredential
} from './antigravity-oauth-credential'

const NESTED = {
  auth_method: 'consumer',
  token: {
    access_token: 'access-1',
    token_type: 'Bearer',
    refresh_token: 'refresh-1',
    expiry: '2026-09-07T12:44:03.30722+09:00'
  }
}

describe('parseAntigravityOAuthCredential', () => {
  it('reads the nested token the Antigravity CLI writes', () => {
    expect(parseAntigravityOAuthCredential(JSON.stringify(NESTED))).toEqual({
      accessToken: 'access-1',
      expiresAt: new Date('2026-09-07T12:44:03.30722+09:00').getTime()
    })
  })

  it('reads the same payload behind the go-keyring base64 prefix', () => {
    const encoded = `go-keyring-base64:${Buffer.from(JSON.stringify(NESTED)).toString('base64')}`
    expect(parseAntigravityOAuthCredential(encoded)?.accessToken).toBe('access-1')
  })

  it('reads a flat payload that has no token wrapper', () => {
    const flat = JSON.stringify({ access_token: 'access-2', expiry: '2026-01-01T00:00:00Z' })
    expect(parseAntigravityOAuthCredential(flat)?.accessToken).toBe('access-2')
  })

  it('keeps a usable token whose expiry is unparseable', () => {
    const odd = JSON.stringify({ token: { access_token: 'access-3', expiry: 'not-a-date' } })
    expect(parseAntigravityOAuthCredential(odd)).toEqual({
      accessToken: 'access-3',
      expiresAt: null
    })
  })

  it('rejects blobs with no access token', () => {
    expect(parseAntigravityOAuthCredential('not json')).toBeNull()
    expect(parseAntigravityOAuthCredential('{}')).toBeNull()
    expect(
      parseAntigravityOAuthCredential(JSON.stringify({ token: { access_token: '' } }))
    ).toBeNull()
  })
})

describe('isAntigravityCredentialExpired', () => {
  const at = (expiresAt: number | null) => ({ accessToken: 'a', expiresAt })

  it('treats an elapsed expiry as expired', () => {
    expect(isAntigravityCredentialExpired(at(1_000), 1_001)).toBe(true)
    expect(isAntigravityCredentialExpired(at(1_000), 1_000)).toBe(true)
  })

  it('treats a future expiry as usable', () => {
    expect(isAntigravityCredentialExpired(at(2_000), 1_000)).toBe(false)
  })

  it('lets the API decide when the expiry is unknown', () => {
    expect(isAntigravityCredentialExpired(at(null), 1_000)).toBe(false)
  })
})
