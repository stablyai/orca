import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RelayConfig } from './config.js'
import { createRelayTokenVerifier } from './relay-token-verifier.js'
import { createStaleIfErrorJWKSet, RELAY_JWKS_MAX_STALE_MS } from './stale-if-error-jwks.js'

const config = {
  jwksUrl: 'https://auth.example.test/.well-known/jwks.json',
  authIssuer: 'https://auth.example.test',
  authAudience: 'orca-relay'
} satisfies Partial<RelayConfig>

type SigningKey = { kid: string; privateKey: CryptoKey; jwk: JWK }

async function signingKey(kid: string): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true })
  return { kid, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' } }
}

async function relayToken(key: SigningKey): Promise<string> {
  return await new SignJWT({ prof: 'profile-1', relayHostId: 'abcdefghijklmnop', purpose: 'host-control' })
    .setProtectedHeader({ alg: 'ES256', kid: key.kid })
    .setIssuer(config.authIssuer)
    .setAudience(config.authAudience)
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key.privateKey)
}

function auth(initial: SigningKey) {
  const state = { key: initial, up: true }
  const fetch = vi.fn(async () => {
    if (!state.up) throw new TypeError('fetch failed')
    return Response.json({ keys: [state.key.jwk] })
  })
  return { state, fetch }
}

const MINUTE = 60 * 1000

beforeEach(() => vi.useFakeTimers({ now: Date.parse('2026-10-11T13:00:00Z') }))
afterEach(() => vi.useRealTimers())

describe('relay token keys while auth is down', () => {
  it('accepts a valid token from the last served set once the cache is past its 10 min age', async () => {
    const key = await signingKey('auth-1')
    const authServer = auth(key)
    const jwks = createStaleIfErrorJWKSet(new URL(config.jwksUrl), { fetch: authServer.fetch })
    const verify = createRelayTokenVerifier(config as RelayConfig, jwks)
    expect(await verify(await relayToken(key))).not.toBeNull()

    vi.setSystemTime(Date.now() + 20 * MINUTE)
    authServer.state.up = false
    const fetches = authServer.fetch.mock.calls.length
    expect(await verify(await relayToken(key))).toMatchObject({ sub: 'user-1' })
    expect(authServer.fetch.mock.calls.length).toBe(fetches + 1)
    // Inside the retry window the stale set answers without waiting on another fetch.
    expect(await verify(await relayToken(key))).not.toBeNull()
    expect(authServer.fetch.mock.calls.length).toBe(fetches + 1)
  })

  it('rejects a token signed by a key the last served set never had', async () => {
    const key = await signingKey('auth-1')
    const authServer = auth(key)
    const jwks = createStaleIfErrorJWKSet(new URL(config.jwksUrl), { fetch: authServer.fetch })
    const verify = createRelayTokenVerifier(config as RelayConfig, jwks)
    expect(await verify(await relayToken(key))).not.toBeNull()

    vi.setSystemTime(Date.now() + MINUTE)
    authServer.state.up = false
    expect(await verify(await relayToken(await signingKey('unknown')))).toBeNull()
  })

  it('rejects once the last served set is older than the bound', async () => {
    const key = await signingKey('auth-1')
    const authServer = auth(key)
    const jwks = createStaleIfErrorJWKSet(new URL(config.jwksUrl), { fetch: authServer.fetch })
    const verify = createRelayTokenVerifier(config as RelayConfig, jwks)
    expect(await verify(await relayToken(key))).not.toBeNull()

    vi.setSystemTime(Date.now() + RELAY_JWKS_MAX_STALE_MS + 1)
    authServer.state.up = false
    expect(await verify(await relayToken(key))).toBeNull()
  })

  it('bounds the stale set at 30 minutes since the last served set', async () => {
    expect(RELAY_JWKS_MAX_STALE_MS).toBe(30 * MINUTE)
    const key = await signingKey('auth-1')
    const authServer = auth(key)
    const verify = createRelayTokenVerifier(
      config as RelayConfig,
      createStaleIfErrorJWKSet(new URL(config.jwksUrl), { fetch: authServer.fetch })
    )
    expect(await verify(await relayToken(key))).not.toBeNull()
    authServer.state.up = false
    vi.setSystemTime(Date.now() + 29 * MINUTE)
    expect(await verify(await relayToken(key))).not.toBeNull()
    vi.setSystemTime(Date.now() + 2 * MINUTE)
    expect(await verify(await relayToken(key))).toBeNull()
  })

  it('fails closed in a process that has not fetched a set yet, as after a restart', async () => {
    const key = await signingKey('auth-1')
    const authServer = auth(key)
    authServer.state.up = false
    const jwks = createStaleIfErrorJWKSet(new URL(config.jwksUrl), { fetch: authServer.fetch })
    const verify = createRelayTokenVerifier(config as RelayConfig, jwks)
    expect(await verify(await relayToken(key))).toBeNull()
    authServer.state.up = true
    expect(await verify(await relayToken(key))).not.toBeNull()
  })

  it('picks up a rotated key once auth is back, and drops the rotated-out one', async () => {
    const before = await signingKey('auth-1')
    const authServer = auth(before)
    const jwks = createStaleIfErrorJWKSet(new URL(config.jwksUrl), { fetch: authServer.fetch })
    const verify = createRelayTokenVerifier(config as RelayConfig, jwks)
    expect(await verify(await relayToken(before))).not.toBeNull()

    const after = await signingKey('auth-2')
    vi.setSystemTime(Date.now() + 20 * MINUTE)
    authServer.state.up = false
    expect(await verify(await relayToken(after))).toBeNull()

    authServer.state.key = after
    authServer.state.up = true
    vi.setSystemTime(Date.now() + MINUTE)
    expect(await verify(await relayToken(after))).not.toBeNull()
    expect(await verify(await relayToken(before))).toBeNull()
  })
})
