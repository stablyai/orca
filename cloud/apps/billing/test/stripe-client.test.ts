import { describe, expect, it } from 'vitest'
import type { Env } from '../src/env'
import { LiveModeRefusedError, assertKeyMode, createStripeClient, encodeForm } from '../src/stripe'

const env = (key: string, extra: Partial<Env> = {}) => ({ STRIPE_SECRET_KEY: key, ...extra }) as Env

describe('stripe client', () => {
  it('encodes nested params with Stripe bracket syntax and drops undefined', () => {
    expect(
      decodeURIComponent(
        encodeForm({ mode: 'subscription', line_items: [{ price: 'p', quantity: 2 }, { price: 'o' }], metadata: { a: 'b' }, x: undefined })
      )
    ).toBe('mode=subscription&line_items[0][price]=p&line_items[0][quantity]=2&line_items[1][price]=o&metadata[a]=b')
  })

  it('refuses live-mode keys unless live mode is explicitly enabled', () => {
    expect(() => assertKeyMode(env('sk_live_x'))).toThrow(LiveModeRefusedError)
    expect(() => assertKeyMode(env('rk_live_x'))).toThrow(LiveModeRefusedError)
    expect(() => assertKeyMode(env('rk_live_x', { STRIPE_ALLOW_LIVEMODE: '1' }))).toThrow(LiveModeRefusedError)
    expect(() => assertKeyMode(env('rk_live_x', { STRIPE_ALLOW_LIVEMODE: 'true' }))).not.toThrow()
    expect(() => assertKeyMode(env('rk_test_x'))).not.toThrow()
    expect(() => assertKeyMode(env(''))).toThrow('stripe_key_missing')
  })

  it('never sends a request with a live key', async () => {
    let called = false
    const client = createStripeClient(env('sk_live_x'), async () => {
      called = true
      return Response.json({})
    })
    await expect(client.retrieveSubscription('sub_1')).rejects.toThrow(LiveModeRefusedError)
    expect(called).toBe(false)
  })

  it('pins the API version, sends an idempotency key and refuses redirects', async () => {
    let seen: RequestInit | undefined
    const client = createStripeClient(env('rk_test_x'), async (_url, init) => {
      seen = init
      return Response.json({ id: 'cus_1' })
    })
    await client.createCustomer({ accountId: 'org:o1' })
    const headers = new Headers(seen?.headers)
    expect(headers.get('stripe-version')).toBe('2025-09-30.clover')
    expect(headers.get('idempotency-key')).toBe('customer-create:org:o1')
    expect(seen?.redirect).toBe('manual')
  })
})
