import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { AUTH_ISSUER, testConnectorConfig } from './connector-server-harness.test-fixture.js'
import {
  connectorHostId,
  createConnectorTokenVerifier,
  readBearer,
  type ConnectorTokenVerifier
} from './connector-token-verifier.js'

const MACHINE_ID = 'm4chine-1d-0123456789'
const CLAIMS = { prof: 'profile-1', sid: 'family-1', mid: MACHINE_ID, purpose: 'connector-host' }

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']
let verify: ConnectorTokenVerifier

beforeAll(async () => {
  const pair = await generateKeyPair('ES256')
  privateKey = pair.privateKey
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256' }
  verify = createConnectorTokenVerifier(testConnectorConfig(), createLocalJWKSet({ keys: [jwk] }))
})

async function sign(
  payload: JWTPayload = CLAIMS,
  { audience = 'orca-connector', issuer = AUTH_ISSUER, expiresIn = '5m', key = privateKey } = {}
): Promise<string> {
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key)
}

describe('connector token verifier', () => {
  it('accepts a connector token and names the machine by account and machine id', async () => {
    const claims = await verify(await sign())
    expect(claims).toMatchObject({ sub: 'user-1', mid: MACHINE_ID, sid: 'family-1' })
    expect(claims && connectorHostId(claims)).toBe(`user-1:${MACHINE_ID}`)
  })

  it('refuses tokens meant for something else, expired, or signed by another key', async () => {
    const otherKey = (await generateKeyPair('ES256')).privateKey
    const refused = [
      await sign(CLAIMS, { audience: 'orca-relay' }),
      await sign({ ...CLAIMS, purpose: 'host-control' }),
      await sign(CLAIMS, { issuer: 'https://elsewhere.example' }),
      await sign(CLAIMS, { expiresIn: '-1s' }),
      await sign(CLAIMS, { key: otherKey }),
      await sign({ ...CLAIMS, mid: 'short' }),
      await sign({ ...CLAIMS, mid: 'has:colon-0123456789' }),
      'not-a-jwt'
    ]
    for (const token of refused) {
      expect(await verify(token)).toBeNull()
    }
  })

  it('reads only a single bearer token', () => {
    expect(readBearer('Bearer abc')).toBe('abc')
    expect(readBearer('Bearer a b')).toBeNull()
    expect(readBearer('Basic abc')).toBeNull()
    expect(readBearer(undefined)).toBeNull()
  })
})
