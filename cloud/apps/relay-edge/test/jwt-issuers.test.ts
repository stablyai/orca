// Trusted token issuers: RELAY_AUTH_ISSUER takes one issuer (as before) or a comma-separated list,
// e.g. during an issuer rotation; a relay JWT is accepted from any listed issuer.
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from 'jose'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { edgeConfig, relayAuthIssuers, type Env } from '../src/env'
import { verifyRelayJwt } from '../src/jwt'

const ISSUER_A = 'https://issuer-a.example.test'
const ISSUER_B = 'https://issuer-b.example.test'
const HOST = 'AAAAAAAAAAAAAAAA'
const NOW_SECONDS = 1_800_000_000
let privateKey: CryptoKey
let inlineJwks: string

beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true })
  privateKey = pair.privateKey
  inlineJwks = JSON.stringify({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' }] })
})

afterEach(() => {
  vi.useRealTimers()
})

const mint = (issuer: string) =>
  new SignJWT({ prof: 'p', relayHostId: HOST, purpose: 'host-control' })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setSubject('u')
    .setIssuer(issuer)
    .setAudience('orca-relay')
    .setIssuedAt(NOW_SECONDS)
    .setExpirationTime(NOW_SECONDS + 300)
    .sign(privateKey)

const envWithIssuer = (issuer: string) =>
  ({ RELAY_JWKS: inlineJwks, RELAY_AUTH_ISSUER: issuer, RELAY_JWT_AUDIENCE: 'orca-relay' }) as Env

function pinClock() {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW_SECONDS * 1000)
}

describe('RELAY_AUTH_ISSUER', () => {
  it('parses one value as before and a list into trimmed, non-empty entries', () => {
    expect(relayAuthIssuers({ RELAY_AUTH_ISSUER: ISSUER_A })).toEqual([ISSUER_A])
    expect(relayAuthIssuers({ RELAY_AUTH_ISSUER: ` ${ISSUER_A} ,, ${ISSUER_B} ,` })).toEqual([ISSUER_A, ISSUER_B])
    expect(relayAuthIssuers({})).toEqual([])
  })

  it('a single issuer accepts its own tokens and rejects others', async () => {
    pinClock()
    const env = envWithIssuer(ISSUER_A)
    expect((await verifyRelayJwt(env, await mint(ISSUER_A))).ok).toBe(true)
    expect(await verifyRelayJwt(env, await mint(ISSUER_B))).toEqual({ ok: false, reason: 'invalid' })
  })

  it('a list accepts tokens from any listed issuer and rejects an unlisted one', async () => {
    pinClock()
    const env = envWithIssuer(`${ISSUER_A}, ${ISSUER_B}`)
    expect((await verifyRelayJwt(env, await mint(ISSUER_A))).ok).toBe(true)
    expect((await verifyRelayJwt(env, await mint(ISSUER_B))).ok).toBe(true)
    expect(await verifyRelayJwt(env, await mint('https://issuer-c.example.test'))).toEqual({
      ok: false,
      reason: 'invalid'
    })
  })

  it('config still requires an issuer when keys come from a JWKS URL, now also for an empty list', () => {
    const base = {
      HYPERDRIVE: {},
      RELAY_JWKS_URL: `${ISSUER_A}/jwks`,
      RELAY_JWT_AUDIENCE: 'orca-relay',
      PING_INTERVAL_MS: '25000',
      SILENCE_TIMEOUT_MS: '75000',
      ORPHAN_GRACE_MS: '60000'
    }
    const config = (extra: Partial<Env>) => edgeConfig({ ...base, ...extra } as unknown as Env)
    expect(() => config({})).toThrow('relay_edge_config_issuer')
    expect(() => config({ RELAY_AUTH_ISSUER: ' , ' })).toThrow('relay_edge_config_issuer')
    expect(config({ RELAY_AUTH_ISSUER: ISSUER_A }).backend).toBe('postgres')
    expect(config({ RELAY_AUTH_ISSUER: `${ISSUER_A},${ISSUER_B}` }).backend).toBe('postgres')
  })
})
