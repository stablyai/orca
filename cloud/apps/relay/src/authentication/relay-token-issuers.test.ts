// Trusted token issuers: ORCA_RELAY_AUTH_ISSUER takes one origin (as before) or a comma-separated
// list, e.g. during an issuer rotation; a relay token is accepted from any listed issuer.
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWTVerifyGetKey } from 'jose'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadRelayConfig } from '../config.js'
import { createRelayTokenVerifier } from './relay-token-verifier.js'

const ISSUER_A = 'https://issuer-a.example.test'
const ISSUER_B = 'https://issuer-b.example.test'
const NOW_SECONDS = 1_800_000_000

function configWithIssuer(issuer: string) {
  return loadRelayConfig({
    ORCA_RELAY_PUBLIC_URL: 'http://127.0.0.1',
    ORCA_RELAY_CELL_URL: 'http://127.0.0.1',
    ORCA_RELAY_AUTH_ISSUER: issuer,
    ORCA_RELAY_JWKS_URL: 'https://issuer-a.example.test/jwks',
    ORCA_RELAY_ASSIGNMENT_SIGNING_KEY: 'synthetic-assignment-key-for-test-only',
    ORCA_RELAY_ADMIN_AUDIENCE: 'https://issuer-a.example.test/admin',
    ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT: 'deploy@example.test'
  })
}

describe('ORCA_RELAY_AUTH_ISSUER', () => {
  it('parses a single issuer to the same canonical origin as before', () => {
    expect(configWithIssuer(ISSUER_A).authIssuer).toBe(ISSUER_A)
  })

  it('parses a comma-separated list into trimmed entries', () => {
    expect(configWithIssuer(`${ISSUER_A},${ISSUER_B}`).authIssuer).toEqual([ISSUER_A, ISSUER_B])
    expect(configWithIssuer(` ${ISSUER_A} , ${ISSUER_B} `).authIssuer).toEqual([ISSUER_A, ISSUER_B])
  })

  it('fails config on an empty entry instead of skipping it', () => {
    for (const value of ['', ' ', ',', ' , ', `${ISSUER_A},`, `,${ISSUER_A}`, `${ISSUER_A},,${ISSUER_B}`, `${ISSUER_A}, ,${ISSUER_B}`]) {
      expect(() => configWithIssuer(value), JSON.stringify(value)).toThrow('ORCA_RELAY_AUTH_ISSUER has an empty entry')
    }
  })

  it('fails config when any entry is invalid, as a single invalid value does', () => {
    expect(() => configWithIssuer('not-a-url')).toThrow('Invalid URL')
    expect(() => configWithIssuer(`${ISSUER_A},not-a-url`)).toThrow('Invalid URL')
    expect(() => configWithIssuer(`${ISSUER_A}/path`)).toThrow('ORCA_RELAY_AUTH_ISSUER must be an origin')
    expect(() => configWithIssuer(`${ISSUER_A},${ISSUER_B}/path`)).toThrow('ORCA_RELAY_AUTH_ISSUER must be an origin')
    expect(() => configWithIssuer(`${ISSUER_A},http://issuer-b.example.test`)).toThrow(
      'ORCA_RELAY_AUTH_ISSUER must use HTTPS outside loopback development'
    )
  })
})

describe('relay token verifier with several trusted issuers', () => {
  let privateKey: CryptoKey
  let jwks: JWTVerifyGetKey

  beforeAll(async () => {
    const pair = await generateKeyPair('ES256', { extractable: true })
    privateKey = pair.privateKey
    jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' }] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const mint = (issuer: string) =>
    new SignJWT({ prof: 'profile-1', relayHostId: 'abcdefghijklmnop', purpose: 'host-control' })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(issuer)
      .setAudience('orca-relay')
      .setSubject('user-1')
      .setIssuedAt(NOW_SECONDS)
      .setExpirationTime(NOW_SECONDS + 300)
      .sign(privateKey)

  function pinClock() {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW_SECONDS * 1000)
  }

  it('accepts a token from any listed issuer and rejects an unlisted one', async () => {
    pinClock()
    const verify = createRelayTokenVerifier(configWithIssuer(`${ISSUER_A},${ISSUER_B}`), jwks)
    expect(await verify(await mint(ISSUER_A))).toMatchObject({ sub: 'user-1' })
    expect(await verify(await mint(ISSUER_B))).toMatchObject({ sub: 'user-1' })
    expect(await verify(await mint('https://issuer-c.example.test'))).toBeNull()
  })

  it('a single issuer still rejects tokens from other issuers', async () => {
    pinClock()
    const verify = createRelayTokenVerifier(configWithIssuer(ISSUER_A), jwks)
    expect(await verify(await mint(ISSUER_A))).toMatchObject({ sub: 'user-1' })
    expect(await verify(await mint(ISSUER_B))).toBeNull()
  })
})
