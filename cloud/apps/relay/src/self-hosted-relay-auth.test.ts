import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { loadRelayConfig } from './config.js'
import { createRelayTokenVerifier, selfHostedRelaySigningKey } from './relay-token-verifier.js'
import { registerSelfHostedRelayAuth } from './self-hosted-relay-auth.js'

const environment = {
  ORCA_RELAY_PUBLIC_URL: 'https://relay.example.test',
  ORCA_RELAY_CELL_URL: 'https://relay.example.test',
  ORCA_RELAY_SELF_HOSTED_KEY: 'owner-access-key-with-at-least-32-characters',
  ORCA_RELAY_ASSIGNMENT_SIGNING_KEY: 'server-signing-key-with-at-least-32-characters'
}
const publicKey = Buffer.alloc(32, 7)
const request = {
  hostPublicKeyB64: publicKey.toString('base64'),
  relayHostId: createHash('sha256').update(publicKey).digest('base64url').slice(0, 16)
}

function setup() {
  const config = loadRelayConfig(environment)
  const app = new Hono()
  registerSelfHostedRelayAuth(app, config)
  const post = (key = environment.ORCA_RELAY_SELF_HOSTED_KEY, body: unknown = request) =>
    app.request('/v1/host-token', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  return { config, app, post, verify: createRelayTokenVerifier(config) }
}

describe('self-hosted Relay authorization', () => {
  it('issues an expiring host token without external auth or service accounts', async () => {
    const { config, post, verify } = setup()
    expect(config.jwksUrl).toBeUndefined()
    expect(config.deployServiceAccount).toBeUndefined()
    const response = await post()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const result = z
      .object({ relayToken: z.string(), expiresAt: z.number() })
      .parse(await response.json())
    expect(result.expiresAt).toBeGreaterThan(Date.now())
    expect(result.expiresAt).toBeLessThanOrEqual(Date.now() + 15 * 60_000)
    expect(await verify(result.relayToken)).toEqual({
      sub: 'self-hosted',
      prof: config.publicUrl,
      purpose: 'host-control',
      relayHostId: request.relayHostId,
      exp: result.expiresAt / 1000
    })
    expect(JSON.stringify(result)).not.toContain(environment.ORCA_RELAY_SELF_HOSTED_KEY)
    expect(await verify(environment.ORCA_RELAY_SELF_HOSTED_KEY)).toBeNull()
  })

  it('refuses unauthenticated registration, mismatched host keys, and large bodies', async () => {
    const { post } = setup()
    expect((await post('wrong-key')).status).toBe(401)
    expect((await post('', null)).status).toBe(401)
    expect((await post(undefined, { ...request, relayHostId: 'abcdefghijklmnop' })).status).toBe(
      400
    )
    expect((await post(undefined, { ...request, hostPublicKeyB64: 'invalid' })).status).toBe(400)
    expect((await post(undefined, { ...request, extra: 'a'.repeat(4096) })).status).toBe(413)
  })

  it('keeps cloud administration disabled, including for the owner key', async () => {
    const { app } = setup()
    const drain = vi.fn()
    app.post('/v1/admin/drain', (context) => {
      drain()
      return context.json({ ok: true })
    })
    const response = await app.request('/v1/admin/drain', {
      method: 'POST',
      headers: { authorization: `Bearer ${environment.ORCA_RELAY_SELF_HOSTED_KEY}` }
    })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'not_found' })
    expect(drain).not.toHaveBeenCalled()
  })

  it('rejects an owner key that also grants assignment signing authority', () => {
    expect(() =>
      loadRelayConfig({
        ...environment,
        ORCA_RELAY_ASSIGNMENT_SIGNING_KEY: environment.ORCA_RELAY_SELF_HOSTED_KEY
      })
    ).toThrow('self-hosted relay requires different owner and signing keys')
  })

  it('rejects expired tokens, other audiences and assignment signing keys', async () => {
    const { config, verify } = setup()
    const claims = {
      sub: 'self-hosted',
      prof: config.publicUrl,
      purpose: 'host-control',
      relayHostId: request.relayHostId
    }
    for (const [audience, expiry, key] of [
      ['orca-relay', 1, selfHostedRelaySigningKey(config)],
      ['wrong-audience', Math.floor(Date.now() / 1000) + 60, selfHostedRelaySigningKey(config)],
      ['orca-relay', Math.floor(Date.now() / 1000) + 60, config.assignmentSigningKey]
    ] as const) {
      const token = await new SignJWT(claims)
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(config.authIssuer)
        .setAudience(audience)
        .setExpirationTime(expiry)
        .sign(key)
      expect(await verify(token)).toBeNull()
    }
  })

  it('fails closed on missing cloud auth, weak keys, split roles and mixed authentication', () => {
    expect(() =>
      loadRelayConfig({ ...environment, ORCA_RELAY_SELF_HOSTED_KEY: undefined })
    ).toThrow()
    for (const overrides of [
      { ORCA_RELAY_SELF_HOSTED_KEY: 'short' },
      { ORCA_RELAY_SELF_HOSTED_KEY: 'key with spaces'.repeat(3) },
      { ORCA_RELAY_ROLE: 'cell' },
      { ORCA_RELAY_CELL_URL: 'https://other.example.test' },
      { ORCA_RELAY_JWKS_URL: 'https://auth.example.test/jwks' },
      { ORCA_RELAY_AUTH_ISSUER: 'https://auth.example.test' },
      { ORCA_RELAY_DIRECTOR_URL: 'https://other.example.test' }
    ])
      expect(() => loadRelayConfig({ ...environment, ...overrides })).toThrow()
  })
})
