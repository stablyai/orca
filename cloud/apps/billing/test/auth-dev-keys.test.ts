import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { describe, expect, it } from 'vitest'
import { DEV_ISSUER } from '../src/auth'
import { createHarness } from './harness'

async function devKeyPair() {
  const { privateKey, publicKey } = await generateKeyPair('ES256')
  const jwks = JSON.stringify({ keys: [{ ...(await exportJWK(publicKey)), kid: 'dev', alg: 'ES256' }] })
  const sign = (issuer: string) => {
    const now = Math.floor(Date.now() / 1000)
    return new SignJWT({ sub: 'u1', purpose: 'billing' })
      .setProtectedHeader({ alg: 'ES256', kid: 'dev' })
      .setIssuer(issuer)
      .setAudience('orca-billing')
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey)
  }
  return { jwks, sign }
}

describe('dev operator keys', () => {
  it('accepts dev-issuer tokens outside prod only, and only with the dev issuer', async () => {
    const dev = await devKeyPair()
    const call = async (env: Record<string, string>, token: string) => {
      const h = await createHarness(env)
      return (await h.call('GET', '/v1/billing/entitlements', { headers: { authorization: `Bearer ${token}` } })).status
    }
    expect(await call({ BILLING_ENV: 'dev', BILLING_DEV_JWKS: dev.jwks }, await dev.sign(DEV_ISSUER))).toBe(200)
    expect(await call({ BILLING_ENV: 'prod', BILLING_DEV_JWKS: dev.jwks }, await dev.sign(DEV_ISSUER))).toBe(401)
    // A dev key cannot impersonate the real issuer.
    expect(await call({ BILLING_ENV: 'dev', BILLING_DEV_JWKS: dev.jwks }, await dev.sign('https://login.onorca.dev'))).toBe(401)
    expect(await call({ BILLING_ENV: 'dev' }, await dev.sign(DEV_ISSUER))).toBe(401)
  })

  it('serves a static return page for Checkout and the Portal', async () => {
    const h = await createHarness()
    const { handleRequest } = await import('../src/index')
    const response = await handleRequest(new Request('https://billing.test/return?checkout=success'), h.env, {
      waitUntil() {},
      passThroughOnException() {}
    } as unknown as ExecutionContext)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('return to Orca')
  })
})
