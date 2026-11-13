import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { describe, expect, it } from 'vitest'
import { authenticateDesktop, issuerList } from '../src/auth'
import { createHarness } from './harness'

const PROD = 'https://login.onorca.dev'
const NEXT = 'https://login.example.dev'

async function issuerHarness(issuers: string) {
  const { privateKey, publicKey } = await generateKeyPair('ES256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'iss1', alg: 'ES256', use: 'sig' }
  const h = await createHarness({ SANDBOX_JWKS: JSON.stringify({ keys: [jwk] }), SANDBOX_AUTH_ISSUER: issuers })
  const accepts = async (issuer: string): Promise<boolean> => {
    const iat = Math.floor(h.now() / 1000)
    const token = await new SignJWT({ sub: 'user_iss', purpose: 'sandbox' })
      .setProtectedHeader({ alg: 'ES256', kid: 'iss1' })
      .setIssuer(issuer)
      .setAudience('orca-sandbox')
      .setIssuedAt(iat)
      .setExpirationTime(iat + 300)
      .sign(privateKey)
    const request = new Request('https://sandbox.test/v1/config', { headers: { authorization: `Bearer ${token}` } })
    return (await authenticateDesktop(h.env, request, h.now())) !== null
  }
  return { accepts }
}

describe('SANDBOX_AUTH_ISSUER list', () => {
  it('parses a comma list, ignoring whitespace and empty entries', () => {
    expect(issuerList(undefined)).toBeUndefined()
    expect(issuerList('')).toBeUndefined()
    expect(issuerList(PROD)).toEqual([PROD])
    expect(issuerList(` ${PROD} ,, ${NEXT} , `)).toEqual([PROD, NEXT])
  })

  it('a single issuer behaves as before', async () => {
    const h = await issuerHarness(PROD)
    expect(await h.accepts(PROD)).toBe(true)
    expect(await h.accepts(NEXT)).toBe(false)
  })

  it('a list accepts each listed issuer and rejects others', async () => {
    const h = await issuerHarness(` ${PROD} , ,${NEXT},`)
    expect(await h.accepts(PROD)).toBe(true)
    expect(await h.accepts(NEXT)).toBe(true)
    expect(await h.accepts('https://login.evil.dev')).toBe(false)
  })

  it('a value with no entries accepts no issuer', async () => {
    const h = await issuerHarness(' , ')
    expect(await h.accepts(PROD)).toBe(false)
  })
})
