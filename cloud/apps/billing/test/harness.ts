import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import type { Env } from '../src/env'
import { handleRequest } from '../src/index'
import { createStripeClient } from '../src/stripe'
import { createFakeD1 } from './d1-fake'
import { createFakeStripe, signStripePayload } from './stripe-fake'

export const WEBHOOK_SECRET = 'whsec_test_local_fixture_secret'
export const CONTROL_TOKEN = 'cp_test_0123456789abcdef0123456789abcdef'

export async function createHarness(overrides: Partial<Env> = {}) {
  const { privateKey, publicKey } = await generateKeyPair('ES256')
  const jwk = { ...(await exportJWK(publicKey)), kid: `k${Math.random()}`, alg: 'ES256', use: 'sig' }
  const { db, raw } = createFakeD1()
  const stripe = createFakeStripe()
  const env: Env = {
    BILLING_DB: db,
    STRIPE_SECRET_KEY: 'rk_test_fixture',
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_API_BASE: 'https://stripe.test',
    STRIPE_PRICE_TEAM_MONTHLY: 'price_team_month',
    STRIPE_PRICE_TEAM_ANNUAL: 'price_team_year',
    STRIPE_PRICE_OVERAGE: 'price_overage',
    STRIPE_METER_EVENT_NAME: 'orca_sandbox_seconds',
    BILLING_RETURN_URL: 'https://onorca.dev/billing/return',
    BILLING_JWKS: JSON.stringify({ keys: [jwk] }),
    BILLING_JWT_AUDIENCE: 'orca-billing',
    BILLING_AUTH_ISSUER: 'https://login.onorca.dev',
    CONTROL_PLANE_TOKEN: CONTROL_TOKEN,
    ...overrides
  }
  let now = Date.now()
  // Live org member counts from auth; null = not configured (the default).
  let membership: (orgId: string) => Promise<number | null> = async () => null
  const waits: Promise<unknown>[] = []
  const ctx = { waitUntil: (promise: Promise<unknown>) => waits.push(promise), passThroughOnException() {} } as unknown as ExecutionContext

  async function call(method: string, path: string, init: { body?: unknown; rawBody?: string; headers?: Record<string, string> } = {}) {
    const request = new Request(`https://billing.test${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...init.headers },
      body: init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body))
    })
    const response = await handleRequest(request, env, ctx, {
      stripe: createStripeClient(env, stripe.fetchImpl),
      now: () => now,
      membership: (orgId) => membership(orgId)
    })
    await Promise.all(waits.splice(0))
    return { status: response.status, body: (await response.json()) as Record<string, any> }
  }

  return {
    env,
    raw,
    stripe,
    call,
    setNow(value: number) {
      now = value
    },
    setMembership(source: (orgId: string) => Promise<number | null>) {
      membership = source
    },
    async desktopToken(claims: { sub: string; org?: string; orgRole?: string; email?: string; orgMembers?: number }, options: { audience?: string; purpose?: string; ageSeconds?: number } = {}) {
      const iat = Math.floor(now / 1000) - (options.ageSeconds ?? 0)
      return new SignJWT({ ...claims, purpose: options.purpose ?? 'billing' })
        .setProtectedHeader({ alg: 'ES256', kid: jwk.kid })
        .setIssuer('https://login.onorca.dev')
        .setAudience(options.audience ?? 'orca-billing')
        .setIssuedAt(iat)
        .setExpirationTime(iat + 900)
        .sign(privateKey)
    },
    async webhook(event: unknown, secret = WEBHOOK_SECRET) {
      const rawBody = JSON.stringify(event)
      return call('POST', '/v1/stripe/webhook', {
        rawBody,
        headers: { 'stripe-signature': signStripePayload(rawBody, secret, Math.floor(now / 1000)) }
      })
    },
    controlPlane(path: string, body: unknown, token = CONTROL_TOKEN) {
      return call('POST', path, { body, headers: { authorization: `Bearer ${token}` } })
    }
  }
}
