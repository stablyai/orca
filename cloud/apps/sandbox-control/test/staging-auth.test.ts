import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { describe, expect, it } from 'vitest'
import { authenticateDesktop } from '../src/auth'
import { createHarness } from './harness'

const STAGING_ISSUER = 'https://auth-staging.onorca.dev'

async function stagingKey() {
  const { privateKey, publicKey } = await generateKeyPair('ES256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'staging1', alg: 'ES256', use: 'sig' }
  return { privateKey, jwks: JSON.stringify({ keys: [jwk] }) }
}

async function sign(
  privateKey: CryptoKey,
  nowMs: number,
  issuer: string,
  claims: Record<string, string> = {}
): Promise<string> {
  const iat = Math.floor(nowMs / 1000)
  return new SignJWT({ sub: 'user_staging', purpose: 'sandbox', ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'staging1' })
    .setIssuer(issuer)
    .setAudience('orca-sandbox')
    .setIssuedAt(iat)
    .setExpirationTime(iat + 300)
    .sign(privateKey)
}

function bearer(token: string): Request {
  return new Request('https://sandbox.test/v1/config', { headers: { authorization: `Bearer ${token}` } })
}

describe('staging auth tokens', () => {
  it('are trusted in dev with the same accounts billing dev uses', async () => {
    const { privateKey, jwks } = await stagingKey()
    const h = await createHarness({
      SANDBOX_ENV: 'dev',
      SANDBOX_STAGING_JWKS: jwks,
      SANDBOX_STAGING_AUTH_ISSUER: STAGING_ISSUER
    })
    const token = await sign(privateKey, h.now(), STAGING_ISSUER, { org: 'org_s1', org_role: 'owner' })
    const caller = await authenticateDesktop(h.env, bearer(token), h.now())
    expect(caller).toMatchObject({ userId: 'user_staging', accountId: 'org:org_s1', orgRole: 'owner' })
    expect(caller?.dev).toBeUndefined()
    expect((await h.call('GET', '/v1/config', { bearer: token })).status).toBe(200)
  })

  it('are refused in prod, and a staging key cannot claim the prod issuer', async () => {
    const { privateKey, jwks } = await stagingKey()
    const prod = await createHarness({
      SANDBOX_ENV: 'prod',
      SANDBOX_STAGING_JWKS: jwks,
      SANDBOX_STAGING_AUTH_ISSUER: STAGING_ISSUER
    })
    const staging = await sign(privateKey, prod.now(), STAGING_ISSUER)
    expect(await authenticateDesktop(prod.env, bearer(staging), prod.now())).toBeNull()

    const dev = await createHarness({
      SANDBOX_ENV: 'dev',
      SANDBOX_STAGING_JWKS: jwks,
      SANDBOX_STAGING_AUTH_ISSUER: STAGING_ISSUER
    })
    const forged = await sign(privateKey, dev.now(), 'https://login.onorca.dev')
    expect(await authenticateDesktop(dev.env, bearer(forged), dev.now())).toBeNull()
  })
})
