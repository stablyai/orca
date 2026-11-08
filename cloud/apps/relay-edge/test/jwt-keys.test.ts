// Relay JWT verification when keys cannot be fetched: "token invalid" and "no keys to judge it"
// stay apart, and a cold isolate falls back to the colo's persisted set (Cache API, stubbed).
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from 'jose'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/env'
import { PERSISTED_JWKS_MAX_STALE_MS } from '../src/jwks-persist'

const ISSUER = 'https://auth.test.invalid'
const HOST = 'AAAAAAAAAAAAAAAA'
let privateKey: CryptoKey
let otherKey: CryptoKey
let jwks: { keys: Record<string, unknown>[] }
let urlSeq = 0

beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true })
  privateKey = pair.privateKey
  otherKey = (await generateKeyPair('ES256')).privateKey
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' }] }
})

const mint = (key: CryptoKey = privateKey, kid = 'k1') =>
  new SignJWT({ prof: 'p', relayHostId: HOST, purpose: 'host-control' })
    .setProtectedHeader({ alg: 'ES256', kid })
    .setSubject('u')
    .setIssuer(ISSUER)
    .setAudience('orca-relay')
    .setExpirationTime('5m')
    .sign(key)

// A Cache API stand-in shared by every "isolate" (module instance) in the test.
function stubCache(): Map<string, Response> {
  const store = new Map<string, Response>()
  vi.stubGlobal('caches', {
    default: {
      put: async (request: Request, response: Response) => {
        store.set(request.url, new Response(await response.text(), { headers: response.headers }))
      },
      match: async (request: Request) => store.get(request.url)?.clone()
    }
  })
  return store
}

// Each call is a fresh isolate: a new module instance with an empty in-memory key cache.
async function coldVerifier() {
  vi.resetModules()
  return (await import('../src/jwt')).verifyRelayJwt
}

function envFor(url: string): Env {
  return { RELAY_JWKS_URL: url, RELAY_AUTH_ISSUER: ISSUER, RELAY_JWT_AUDIENCE: 'orca-relay' } as Env
}

function authUp(up: () => boolean) {
  vi.stubGlobal('fetch', async () => {
    if (!up()) { throw new TypeError('connection refused') }
    return Response.json(jwks)
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('relay JWT key availability', () => {
  it('reports keys_unavailable, not invalid, when a cold isolate cannot fetch and nothing is persisted', async () => {
    stubCache()
    authUp(() => false)
    const verify = await coldVerifier()
    expect(await verify(envFor(`https://auth.test.invalid/jwks/${++urlSeq}`), await mint())).toEqual({ ok: false, reason: 'keys_unavailable' })
  })

  it('reports keys_unavailable on a non-200 answer', async () => {
    stubCache()
    vi.stubGlobal('fetch', async () => new Response('down', { status: 502 }))
    const verify = await coldVerifier()
    expect(await verify(envFor(`https://auth.test.invalid/jwks/${++urlSeq}`), await mint())).toEqual({ ok: false, reason: 'keys_unavailable' })
  })

  it('still says invalid for a bad token when keys are available', async () => {
    stubCache()
    authUp(() => true)
    const verify = await coldVerifier()
    const env = envFor(`https://auth.test.invalid/jwks/${++urlSeq}`)
    expect(await verify(env, await mint(otherKey))).toEqual({ ok: false, reason: 'invalid' })
    expect(await verify(env, 'not-a-jwt')).toEqual({ ok: false, reason: 'invalid' })
    expect(await verify(env, await mint(privateKey, 'unknown-kid'))).toEqual({ ok: false, reason: 'invalid' })
  })

  it('a cold isolate verifies from the persisted set while auth is down', async () => {
    const store = stubCache()
    let up = true
    authUp(() => up)
    const env = envFor(`https://auth.test.invalid/jwks/${++urlSeq}`)
    const warm = await coldVerifier()
    expect((await warm(env, await mint())).ok).toBe(true)
    expect(store.size).toBe(1)
    up = false
    const cold = await coldVerifier()
    const result = await cold(env, await mint())
    expect(result.ok && result.claims.relayHostId).toBe(HOST)
    // A forged token is still refused from the persisted set.
    expect(await cold(env, await mint(otherKey))).toEqual({ ok: false, reason: 'invalid' })
  })

  it('ignores a persisted set past its max age, and one lacking the token key', async () => {
    const store = stubCache()
    authUp(() => false)
    const url = `https://auth.test.invalid/jwks/${++urlSeq}`
    const stored = (storedAt: number, keys: unknown) =>
      new Response(JSON.stringify(keys), { headers: { 'x-orca-jwks-stored-at': String(storedAt) } })
    store.set(url, stored(Date.now() - PERSISTED_JWKS_MAX_STALE_MS - 1000, jwks))
    expect(await (await coldVerifier())(envFor(url), await mint())).toEqual({ ok: false, reason: 'keys_unavailable' })
    store.set(url, stored(Date.now(), { keys: [] }))
    expect(await (await coldVerifier())(envFor(url), await mint())).toEqual({ ok: false, reason: 'keys_unavailable' })
  })

  it('works without a Cache API (local tests)', async () => {
    authUp(() => true)
    const verify = await coldVerifier()
    expect((await verify(envFor(`https://auth.test.invalid/jwks/${++urlSeq}`), await mint())).ok).toBe(true)
  })
})
