import { describe, expect, it, vi } from 'vitest'
import { parseAntigravityNativeCredential } from './native-credential-codec'
import {
  createGoogleTokeninfoIdentityResolver,
  parseGoogleTokeninfo
} from './native-identity-resolver'

// agy >= 1.4.7 keychain shape: `id_token_email` and no signed `id_token`.
function agy147(accessToken: string, email = 'a@example.invalid') {
  return parseAntigravityNativeCredential(
    JSON.stringify({
      auth_method: 'consumer',
      id_token_email: email,
      token: { access_token: accessToken, refresh_token: 'refresh', token_type: 'Bearer' }
    })
  )
}

function answer(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

const live = {
  sub: 'google-sub-a',
  email: 'a@example.invalid',
  email_verified: 'true',
  expires_in: '3599'
}

describe('Google tokeninfo identity for credentials without an id_token', () => {
  it('accepts only a live answer that names one Google account', () => {
    expect(parseGoogleTokeninfo(live)).toEqual({
      issuer: 'https://accounts.google.com',
      subject: 'google-sub-a',
      email: 'a@example.invalid'
    })
    expect(parseGoogleTokeninfo({ ...live, email_verified: 'false' })?.email).toBeNull()
    expect(parseGoogleTokeninfo({ ...live, sub: '' })).toBeNull()
    expect(parseGoogleTokeninfo({ ...live, expires_in: '0' })).toBeNull()
    expect(parseGoogleTokeninfo({ ...live, expires_in: 'soon' })).toBeNull()
    expect(parseGoogleTokeninfo(['not', 'an', 'object'])).toBeNull()
  })

  it('sends the access token only in a POST body to Google and caches per token', async () => {
    const fetchImpl = vi.fn(async () => answer(live))
    const resolve = createGoogleTokeninfoIdentityResolver(fetchImpl as typeof fetch)
    expect((await resolve(agy147('synthetic-1')))?.subject).toBe('google-sub-a')
    expect((await resolve(agy147('synthetic-1')))?.subject).toBe('google-sub-a')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://oauth2.googleapis.com/tokeninfo')
    expect(url).not.toContain('synthetic-1')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('error')
    expect(String(init.body)).toBe('access_token=synthetic-1')
    expect(JSON.stringify(init.headers)).not.toContain('synthetic-1')
    // A silent refresh is a new token, so Google is asked again.
    await resolve(agy147('synthetic-2'))
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('never asks the network when the credential already carries an id_token identity', async () => {
    const fetchImpl = vi.fn(async () => answer(live))
    const resolve = createGoogleTokeninfoIdentityResolver(fetchImpl as typeof fetch)
    const signed = parseAntigravityNativeCredential(
      JSON.stringify({
        auth_method: 'consumer',
        id_token: `e30.${Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', sub: 'local' })).toString('base64url')}.sig`,
        token: { access_token: 'synthetic-1' }
      })
    )
    expect((await resolve(signed))?.subject).toBe('local')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns no identity for rejected, failed or malformed answers', async () => {
    for (const fetchImpl of [
      vi.fn(async () => answer({ error: 'invalid_token' }, 400)),
      vi.fn(async () => {
        throw new Error('offline synthetic-1')
      }),
      vi.fn(async () => new Response('not json', { status: 200 }))
    ]) {
      const resolve = createGoogleTokeninfoIdentityResolver(fetchImpl as typeof fetch)
      await expect(resolve(agy147('synthetic-1'))).resolves.toBeNull()
    }
    const untouched = vi.fn(async () => answer(live))
    const resolve = createGoogleTokeninfoIdentityResolver(untouched as typeof fetch)
    await expect(resolve(agy147('has space'))).resolves.toBeNull()
    expect(untouched).not.toHaveBeenCalled()
  })
})
