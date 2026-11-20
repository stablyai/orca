import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet, jwtVerify } from 'jose'
import { expect, it } from 'vitest'
import { createService } from './service.js'

it('authenticates upstream users and rejects invalid identity tokens and state', async () => {
  const key = await generateKeyPair('ES256')
  const jwk = { ...await exportJWK(key.publicKey), kid: 'provider', alg: 'ES256' }
  let issuer = '', nonce = '', variant = 'valid'
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/.well-known/openid-configuration') return res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/keys`, userinfo_endpoint: `${issuer}/userinfo` }))
    if (req.url === '/keys') return res.end(JSON.stringify({ keys: [jwk] }))
    if (req.url === '/userinfo') return res.end(JSON.stringify({ sub: 'alice', email: 'alice@example.com', ...(variant === 'userinfo_verified' ? { email_verified: true } : {}) }))
    if (req.url === '/token') {
      const claims = { azp: variant === 'multi_correct_azp' ? 'desktop-provider' : variant === 'multi_wrong_azp' ? 'wrong' : undefined, nonce: variant === 'nonce' ? 'wrong' : nonce, email: variant.startsWith('userinfo_') ? undefined : variant === 'email' ? 'other@example.com' : variant === 'domain' ? 'alice@wrong.test' : variant === 'unicode' ? 'alice@Kelvin.test' : 'alice@example.com', email_verified: variant === 'missing_verified' ? undefined : variant === 'string_verified' ? 'false' : variant !== 'unverified', name: 'Alice' }
      let idToken = await new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid: 'provider' }).setIssuer(variant === 'issuer' ? 'https://wrong.example' : issuer).setAudience(variant === 'audience' ? 'wrong' : variant.startsWith('multi_') ? ['desktop-provider', 'another'] : 'desktop-provider').setSubject('alice').setIssuedAt().setExpirationTime(variant === 'expired' ? '1 second ago' : '5 minutes').sign(key.privateKey)
      if (variant === 'none') idToken = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${idToken.split('.')[1]}.`
      return res.end(JSON.stringify({ id_token: idToken, access_token: 'access' }))
    }
    res.statusCode = 404; res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address')
  issuer = `http://127.0.0.1:${address.port}`
  const dir = mkdtempSync(join(tmpdir(), 'upstream-auth-'))
  const upstream = { issuer, clientId: 'desktop-provider', allowedEmails: ['alice@example.com'], allowedDomains: ['allowed.test', 'kelvin.test'] }
  const service = await createService({ issuer: 'https://auth.example', clientId: 'desktop', secret: '', email: '', userId: 'admin', dataDir: dir, upstream })
  try {
    const verifier = 'a'.repeat(43), redirectUri = 'http://127.0.0.1:1234/auth/callback'
    const query = new URLSearchParams({ client_id: 'desktop', response_type: 'code', redirect_uri: redirectUri, nonce: 'desktop-nonce', state: 'desktop-state', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', local_profile_id: 'local' })
    const post = (path: string, data: object, access?: string) => service.app.request(`/v1/desktop/auth/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(access ? { authorization: `Bearer ${access}` } : {}) }, body: JSON.stringify(data) })
    const start = async () => { const response = await service.app.request(`/v1/desktop/auth/authorize?${query}`); expect(response.status).toBe(303); const url = new URL(response.headers.get('location')!); nonce = url.searchParams.get('nonce')!; return url.searchParams.get('state')! }
    let addressNumber = 0
    const callback = (state: string) => service.app.request(`/v1/desktop/auth/upstream/callback?${new URLSearchParams({ state, code: 'provider-code' })}`, {}, { incoming: { socket: { remoteAddress: `192.0.2.${++addressNumber}` } } })
    const state = await start(), login = await callback(state)
    expect(login.status).toBe(303)
    expect((await callback(state)).status).toBe(401)
    const code = new URL(login.headers.get('location')!).searchParams.get('code')
    const session = await (await post('session', { code, codeVerifier: verifier, nonce: 'desktop-nonce', state: 'desktop-state', redirectUri, localProfileId: 'local' })).json() as { accessToken: string; refreshToken: string; cloud: { userId: string; email: string; cloudProfileId: string } }
    const expectedUser = `${createHash('sha256').update(issuer).digest('base64url')}:alice`
    expect(session.cloud).toMatchObject({ userId: expectedUser, email: 'alice@example.com' })
    const hostKey = Buffer.alloc(32), host = createHash('sha256').update(hostKey).digest('base64url').slice(0, 16)
    const minted = await (await post('relay-token', { relayHostId: host, hostPublicKeyB64: hostKey.toString('base64') }, session.accessToken)).json() as { relayToken: string }
    const keys = await (await service.app.request('/.well-known/jwks.json')).json() as { keys: [] }
    expect((await jwtVerify(minted.relayToken, createLocalJWKSet(keys))).payload).toMatchObject({ sub: expectedUser, prof: session.cloud.cloudProfileId })
    const refreshed = await (await post('refresh', { refreshToken: session.refreshToken })).json() as typeof session
    expect(refreshed.cloud.userId).toBe(expectedUser)
    const db = new DatabaseSync(join(dir, 'sessions.sqlite'))
    db.exec('UPDATE sessions SET expires=4102444800000')
    const profile = await (await post('profile', { refreshToken: refreshed.refreshToken }, refreshed.accessToken)).json() as typeof session
    expect(profile.cloud).toMatchObject({ userId: expectedUser, email: 'alice@example.com', displayName: 'Alice' })
    const expiry = db.prepare('SELECT expires FROM sessions ORDER BY rowid').all() as { expires: number }[]
    expect(expiry[1]?.expires).toBe(4102444800000); db.close()
    upstream.allowedEmails.splice(0); upstream.allowedDomains.splice(0, 2, 'other.test')
    expect((await post('refresh', { refreshToken: profile.refreshToken })).status).toBe(401)
    expect((await post('profile', { refreshToken: profile.refreshToken }, profile.accessToken)).status).toBe(401)
    upstream.allowedEmails.push('alice@example.com'); upstream.allowedDomains.splice(0, 1, 'allowed.test', 'kelvin.test')
    for (variant of ['nonce', 'audience', 'issuer', 'expired', 'unverified', 'missing_verified', 'string_verified', 'email', 'domain', 'unicode', 'none', 'multi_missing_azp', 'multi_wrong_azp', 'userinfo_missing_verified']) {
      const rejected = await callback(await start()); expect(rejected.status).toBe(303)
      const location = new URL(rejected.headers.get('location')!); expect(location.origin).toBe('http://127.0.0.1:1234'); expect(location.searchParams.get('error')).toBe('invalid_grant'); expect(location.searchParams.get('state')).toBe('desktop-state')
    }
    variant = 'userinfo_verified'; expect((await callback(await start())).status).toBe(303)
    variant = 'multi_correct_azp'; expect((await callback(await start())).status).toBe(303)
    expect((await callback('tampered')).status).toBe(401)
  } finally { service.close(); server.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('requires an explicit unrestricted policy and refuses legacy sessions in upstream-only mode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'upstream-policy-'))
  const config = { issuer: 'https://auth.example', clientId: 'desktop', secret: 'a'.repeat(32), email: 'admin@example.com', userId: 'admin', dataDir: dir }
  const upstream = { issuer: 'https://id.example', clientId: 'provider' }
  try {
    await expect(createService({ ...config, upstream })).rejects.toThrow('Upstream requires an allowlist or explicit allowAny')
    const admin = await createService(config)
    const verifier = 'a'.repeat(43), redirectUri = 'http://127.0.0.1:1234/auth/callback'
    const query = new URLSearchParams({ client_id: 'desktop', response_type: 'code', redirect_uri: redirectUri, nonce: 'nonce', state: 'state', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', local_profile_id: 'local' })
    const login = await admin.app.request(`/v1/desktop/auth/authorize?${query}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ secret: config.secret }) })
    const code = new URL(login.headers.get('location')!).searchParams.get('code')
    const result = await admin.app.request('/v1/desktop/auth/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, codeVerifier: verifier, nonce: 'nonce', state: 'state', redirectUri, localProfileId: 'local' }) })
    const session = await result.json() as { refreshToken: string }
    admin.close()
    const db = new DatabaseSync(join(dir, 'sessions.sqlite')); db.exec('UPDATE sessions SET user_id=NULL'); db.close()
    const service = await createService({ ...config, upstream: { ...upstream, allowAny: true } })
    try {
      const refresh = await service.app.request('/v1/desktop/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: session.refreshToken }) })
      expect(refresh.status).toBe(401)
    } finally { service.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
