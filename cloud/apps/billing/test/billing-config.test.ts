import { describe, expect, it } from 'vitest'
import { allowanceWindow, capSeconds, DEFAULT_PLANS } from '../src/plans'
import { createHarness } from './harness'

const HOUR = 3600

describe('config: tax and plan catalog', () => {
  it('leaves Stripe Tax off by default and turns it on with STRIPE_AUTOMATIC_TAX=true', async () => {
    for (const [flag, expected] of [
      [undefined, null],
      ['true', 'true']
    ] as const) {
      const h = await createHarness(flag ? { STRIPE_AUTOMATIC_TAX: flag } : {})
      const token = await h.desktopToken({ sub: 'u1' })
      await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team' }, headers: { authorization: `Bearer ${token}` } })
      const session = h.stripe.calls.find((call) => call.method === 'POST' && call.path === '/v1/checkout/sessions')!
      expect(session.form.get('automatic_tax[enabled]')).toBe(expected)
      expect(session.form.get('tax_id_collection[enabled]')).toBe(expected)
      // Stripe Tax needs the customer's address; Checkout saves it back to the customer.
      expect(session.form.get('customer_update[address]')).toBe('auto')
    }
  })

  it('takes Team numbers and labels and the Enterprise contact from BILLING_PLANS', async () => {
    const h = await createHarness({
      BILLING_PLANS: JSON.stringify({
        team: { includedHoursPerSeat: 40, monthlyPriceLabel: '$45/seat/mo', defaultSpendCapCents: 5000 },
        enterprise: { contactUrl: 'https://example.test/sales' }
      })
    })
    const token = await h.desktopToken({ sub: 'u1' })
    const entitlement = await h.call('GET', '/v1/billing/entitlements', { headers: { authorization: `Bearer ${token}` } })
    expect(entitlement.body.offers).toEqual({
      team: {
        label: 'Team',
        monthlyPriceLabel: '$45/seat/mo',
        annualPriceLabel: '$480/seat/yr',
        monthlyPriceCentsPerSeat: 5000,
        annualPriceCentsPerSeat: 48000,
        largeMachineWeight: 1,
        includedHoursPerSeat: 40,
        concurrentSandboxesPerSeat: 3,
        idleSleepMinutes: 15,
        overageCentsPerHour: 100,
        defaultSpendCapCents: 5000
      },
      enterprise: { label: 'Enterprise', priceLabel: 'Custom', contactUrl: 'https://example.test/sales' }
    })
    expect(entitlement.body.overage.spendCapCents).toBe(5000)
  })

  it('fails closed on a malformed catalog', async () => {
    for (const bad of [
      '{"team":{"includedHoursPerSeat":"lots"}}',
      '{"pro":{}}',
      '{"enterprise":{"contactUrl":"http://insecure.test"}}',
      'not json'
    ]) {
      const h = await createHarness({ BILLING_PLANS: bad })
      const token = await h.desktopToken({ sub: 'u1' })
      expect(await h.call('GET', '/v1/billing/entitlements', { headers: { authorization: `Bearer ${token}` } })).toEqual({
        status: 503,
        body: { error: 'billing_misconfigured' }
      })
    }
  })
})

describe('allowance windows and caps', () => {
  const day = 24 * HOUR * 1000
  it('uses the billing period for monthly plans', () => {
    const period = { start: Date.UTC(2026, 0, 15), end: Date.UTC(2026, 1, 15) }
    expect(allowanceWindow(period, Date.UTC(2026, 1, 1))).toEqual(period)
  })

  it('slices annual plans into monthly windows anchored on the start, clamping short months', () => {
    const period = { start: Date.UTC(2026, 0, 31), end: Date.UTC(2027, 0, 31) }
    expect(allowanceWindow(period, Date.UTC(2026, 1, 10))).toEqual({ start: Date.UTC(2026, 0, 31), end: Date.UTC(2026, 1, 28) })
    expect(allowanceWindow(period, Date.UTC(2026, 2, 1))).toEqual({ start: Date.UTC(2026, 1, 28), end: Date.UTC(2026, 2, 31) })
    expect(allowanceWindow(period, period.end - day)).toEqual({ start: Date.UTC(2026, 11, 31), end: period.end })
  })

  it('converts the $25 default cap to 25 overage hours at $1.00', () => {
    expect(DEFAULT_PLANS.team.overageCentsPerHour).toBe(100)
    expect(capSeconds(DEFAULT_PLANS.team, 2500)).toBe(25 * HOUR)
  })
})
