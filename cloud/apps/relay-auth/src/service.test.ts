import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createLocalJWKSet, jwtVerify, SignJWT } from 'jose'
import { expect, it, vi } from 'vitest'
import { createService } from './service.js'

it('mints a relay token verifiable with JWKS and revokes a reused refresh family', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-auth-'))
  const service = await createService({ issuer: 'https://auth.example', clientId: 'orca-desktop', secret: 'a'.repeat(32), email: 'admin@example.com', userId: 'admin', dataDir: dir })
  try {
    const verifier = 'a'.repeat(43)
    const query = new URLSearchParams({ client_id: 'orca-desktop', response_type: 'code', redirect_uri: 'http://127.0.0.1:1234/auth/callback', nonce: 'nonce', state: 'state', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', local_profile_id: 'local' })
    const login = await service.app.request(`/v1/desktop/auth/authorize?${query}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ secret: 'a'.repeat(32) }) })
    expect(login.status).toBe(303)
    const code = new URL(login.headers.get('location')!).searchParams.get('code')
    const post = (path: string, data: object, access?: string) => service.app.request(`/v1/desktop/auth/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(access ? { authorization: `Bearer ${access}` } : {}) }, body: JSON.stringify(data) })
    const exchange = await post('session', { code, codeVerifier: verifier, nonce: 'nonce', state: 'state', redirectUri: 'http://127.0.0.1:1234/auth/callback', localProfileId: 'local' })
    expect(exchange.status).toBe(200)
    const session = await exchange.json() as { accessToken: string; refreshToken: string; cloud: { cloudProfileId: string } }
    const key = Buffer.alloc(32)
    const host = createHash('sha256').update(key).digest('base64url').slice(0, 16)
    const minted = await post('relay-token', { relayHostId: host, hostPublicKeyB64: key.toString('base64') }, session.accessToken)
    expect(minted.status).toBe(200)
    const { relayToken } = await minted.json() as { relayToken: string }
    const jwks = await (await service.app.request('/.well-known/jwks.json')).json() as { keys: [] }
    const verified = await jwtVerify(relayToken, createLocalJWKSet(jwks), { issuer: 'https://auth.example', audience: 'orca-relay', algorithms: ['ES256'] })
    expect(verified.payload).toMatchObject({ sub: 'admin', prof: session.cloud.cloudProfileId, relayHostId: 'Zmh6rfhivXdsj8GL', purpose: 'host-control' })
    const rotated = await post('refresh', { refreshToken: session.refreshToken })
    expect(rotated.status).toBe(200)
    const next = await rotated.json() as { refreshToken: string }
    const replay = await post('refresh', { refreshToken: session.refreshToken })
    expect(replay.status).toBe(200)
    expect((await replay.json() as { refreshToken: string }).refreshToken).toBe(next.refreshToken)
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 60_001)
    expect((await post('refresh', { refreshToken: session.refreshToken })).status).toBe(401)
    expect((await post('refresh', { refreshToken: next.refreshToken })).status).toBe(401)
    clock.mockRestore()
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})


it('limits failures by socket address and does not count successful logins', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-auth-'))
  const service = await createService({ issuer: 'https://auth.example', clientId: 'orca-desktop', secret: 'a'.repeat(32), email: 'admin@example.com', userId: 'admin', dataDir: dir })
  try {
    const query = new URLSearchParams({ client_id: 'orca-desktop', response_type: 'code', redirect_uri: 'http://127.0.0.1:1234/auth/callback', nonce: 'nonce', state: 'state', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', local_profile_id: 'local' })
    const login = (address: string, secret: string, forwarded?: string) => service.app.request(`/v1/desktop/auth/authorize?${query}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(forwarded ? { 'x-forwarded-for': forwarded } : {}) }, body: new URLSearchParams({ secret }) }, { incoming: { socket: { remoteAddress: address } } })
    for (let i = 0; i < 12; i++) expect((await login('192.0.2.1', 'a'.repeat(32))).status).toBe(303)
    for (let i = 0; i < 10; i++) expect((await login('192.0.2.2', 'wrong', `198.51.100.${i + 1}`)).status).toBe(401)
    expect((await login('192.0.2.2', 'a'.repeat(32), '198.51.100.42')).status).toBe(429)
    expect((await login('192.0.2.1', 'a'.repeat(32))).status).toBe(303)
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('counts concurrent login failures against the live limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-auth-limit-'))
  const service = await createService({ issuer: 'https://auth.example', clientId: 'desktop', secret: 'a'.repeat(32), email: 'admin@example.com', userId: 'admin', dataDir: dir })
  try {
    const query = new URLSearchParams({ client_id: 'desktop', response_type: 'code', redirect_uri: 'http://127.0.0.1:1234/auth/callback', nonce: 'nonce', state: 'state', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', local_profile_id: 'local' })
    const login = () => service.app.request(`/v1/desktop/auth/authorize?${query}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'secret=wrong' })
    expect((await Promise.all(Array.from({ length: 10 }, login))).every(response => response.status === 401)).toBe(true)
    expect((await login()).status).toBe(429)
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('rechecks sessions and profile refresh tokens after pending request work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-auth-logout-'))
  const service = await createService({ issuer: 'https://auth.example', clientId: 'desktop', secret: 'a'.repeat(32), email: 'admin@example.com', userId: 'admin', dataDir: dir })
  try {
    const verifier = 'a'.repeat(43)
    const query = new URLSearchParams({ client_id: 'desktop', response_type: 'code', redirect_uri: 'http://127.0.0.1:1234/auth/callback', nonce: 'nonce', state: 'state', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', local_profile_id: 'local' })
    const post = (path: string, data: object, access?: string) => service.app.request(`/v1/desktop/auth/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(access ? { authorization: `Bearer ${access}` } : {}) }, body: JSON.stringify(data) })
    for (const scenario of ['profile/logout', 'relay-token/logout', 'profile/refresh', 'relay-token/signing']) {
      const path = scenario.split('/')[0]!
      const login = await service.app.request(`/v1/desktop/auth/authorize?${query}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ secret: 'a'.repeat(32) }) })
      const code = new URL(login.headers.get('location')!).searchParams.get('code')
      const session = await (await post('session', { code, codeVerifier: verifier, nonce: 'nonce', state: 'state', redirectUri: 'http://127.0.0.1:1234/auth/callback', localProfileId: 'local' })).json() as { accessToken: string; refreshToken: string }
      const data = path === 'profile' ? { refreshToken: session.refreshToken } : { relayHostId: 'Zmh6rfhivXdsj8GL', hostPublicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }
      const request = new Request(`https://auth.example/v1/desktop/auth/${path}`, { method: 'POST', headers: { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json', 'content-length': String(JSON.stringify(data).length) }, body: JSON.stringify(data) })
      let release!: () => void, started!: () => void
      const reading = new Promise<void>(resolve => { started = resolve })
      const paused = new Promise<void>(resolve => { release = resolve })
      if (scenario === 'relay-token/signing') {
        const sign = SignJWT.prototype.sign
        vi.spyOn(SignJWT.prototype, 'sign').mockImplementationOnce(async function (this: SignJWT, ...args) { started(); await paused; return sign.apply(this, args) })
      } else vi.spyOn(request, 'json').mockImplementation(async () => { started(); await paused; return data })
      const pending = service.app.request(request)
      await reading
      expect((await post(scenario === 'profile/refresh' ? 'refresh' : 'logout', { refreshToken: session.refreshToken }, session.accessToken)).status).toBe(200)
      release()
      expect((await pending).status).toBe(401)
      vi.restoreAllMocks()
    }
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})
