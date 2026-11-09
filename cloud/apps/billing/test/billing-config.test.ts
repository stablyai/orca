import { describe, expect, it } from 'vitest'
import { createHarness } from './harness'
import { stripeEvent } from './stripe-fake'

const HOUR = 3600
const PERIOD_START = Math.floor(Date.now() / 1000) - 5 * 24 * HOUR
const PERIOD_END = PERIOD_START + 30 * 24 * HOUR

describe('config: tax and plan catalog', () => {
  it('leaves Stripe Tax off by default and turns it on with STRIPE_AUTOMATIC_TAX=true', async () => {
    for (const [flag, expected] of [
      [undefined, null],
      ['true', 'true']
    ] as const) {
      const h = await createHarness(flag ? { STRIPE_AUTOMATIC_TAX: flag } : {})
      const token = await h.desktopToken({ sub: 'u1' })
      await h.call('POST', '/v1/billing/checkout', { body: { plan: 'pro' }, headers: { authorization: `Bearer ${token}` } })
      const session = h.stripe.calls.find((call) => call.path === '/v1/checkout/sessions')!
      expect(session.form.get('automatic_tax[enabled]')).toBe(expected)
      expect(session.form.get('tax_id_collection[enabled]')).toBe(expected)
      // Stripe Tax needs the customer's address; Checkout saves it back to the customer.
      expect(session.form.get('customer_update[address]')).toBe('auto')
    }
  })

  it('takes plan entitlements and price labels from BILLING_PLANS', async () => {
    const h = await createHarness({
      BILLING_PLANS: JSON.stringify({ pro: { includedHoursPerSeat: 40, priceLabel: '$20/mo' } })
    })
    const token = await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'owner' })
    await h.call('POST', '/v1/billing/checkout', { body: { plan: 'pro' }, headers: { authorization: `Bearer ${token}` } })
    const customer = [...h.stripe.customers.keys()][0]!
    const sub = h.stripe.putSubscription({
      customer,
      accountId: 'org:o1',
      basePrice: 'price_pro',
      overagePrice: 'price_overage',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END
    })
    await h.webhook(stripeEvent('customer.subscription.created', sub))
    const entitlement = await h.call('GET', '/v1/billing/entitlements', { headers: { authorization: `Bearer ${token}` } })
    expect(entitlement.body).toMatchObject({ includedSeconds: 40 * HOUR })
    expect(entitlement.body.plans).toEqual([
      { plan: 'pro', label: 'Pro', priceLabel: '$20/mo', includedHours: 40, perSeat: false },
      { plan: 'max', label: 'Max', priceLabel: '$100/mo', includedHours: 300, perSeat: false },
      { plan: 'team', label: 'Team', priceLabel: '$60/seat/mo', includedHours: 150, perSeat: true }
    ])
  })

  it('fails closed on a malformed catalog', async () => {
    for (const bad of ['{"pro":{"includedHoursPerSeat":"lots"}}', '{"free":{}}', 'not json']) {
      const h = await createHarness({ BILLING_PLANS: bad })
      const token = await h.desktopToken({ sub: 'u1' })
      expect(await h.call('GET', '/v1/billing/entitlements', { headers: { authorization: `Bearer ${token}` } })).toEqual({
        status: 503,
        body: { error: 'billing_misconfigured' }
      })
    }
  })
})
