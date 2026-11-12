import { describe, expect, it } from 'vitest'
import { allowanceWindow, capSeconds, DEFAULT_PLANS, overageCents, overageUnitAmountDecimal } from '../src/plans'
import { ORCA_CLOUD_OVERAGE_CENTS_PER_HOUR } from '../../../../src/shared/hosted-sandbox/hosted-sandbox-wire'
import { createHarness } from './harness'

const HOUR = 3600

describe('config: tax and plan catalog', () => {
  it('leaves Stripe Tax off by default and turns it on with STRIPE_AUTOMATIC_TAX=true', async () => {
    for (const [flag, expected] of [
      [undefined, null],
      ['true', 'true']
    ] as const) {
      const h = await createHarness(flag ? { STRIPE_AUTOMATIC_TAX: flag } : {})
      const token = await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'owner' })
      await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team' }, headers: { authorization: `Bearer ${token}` } })
      const session = h.stripe.calls.find((call) => call.method === 'POST' && call.path === '/v1/checkout/sessions')!
      expect(session.form.get('automatic_tax[enabled]')).toBe(expected)
      expect(session.form.get('tax_id_collection[enabled]')).toBe(expected)
      // Stripe Tax needs the customer's address; Checkout saves it back to the customer.
      expect(session.form.get('customer_update[address]')).toBe('auto')
    }
  })

  it('takes Team numbers and labels and the Enterprise contact from BILLING_PLANS', async () => {
    // BILLING_PLANS is the legacy catalog: with ENTITLEMENTS_MODE=on prices come from Stripe and the
    // rest from the D1 catalog (test/plans-api.test.ts).
    const h = await createHarness({
      ENTITLEMENTS_MODE: 'off',
      BILLING_PLANS: JSON.stringify({
        team: { includedHoursPerSeat: 40, monthlyPriceLabel: '$45 per seat per month', defaultSpendCapCents: 5000 },
        enterprise: { contactUrl: 'https://example.test/sales' }
      })
    })
    const token = await h.desktopToken({ sub: 'u1' })
    const entitlement = await h.call('GET', '/v1/billing/entitlements', { headers: { authorization: `Bearer ${token}` } })
    expect(entitlement.body.offers).toEqual({
      team: {
        label: 'Team',
        monthlyPriceLabel: '$45 per seat per month',
        annualPriceLabel: '$480 per seat, billed yearly',
        monthlyPriceCentsPerSeat: 5000,
        annualPriceCentsPerSeat: 48000,
        largeMachineWeight: 1,
        includedHoursPerSeat: 40,
        concurrentSandboxesPerSeat: 3,
        idleSleepMinutes: 15,
        overageCentsPerHour: 100,
        defaultSpendCapCents: 5000,
        maxSpendCapCents: 500_000
      },
      enterprise: { label: 'Enterprise', priceLabel: 'Custom', contactUrl: 'https://example.test/sales' },
      // No email on this token: no trial on offer.
      trial: null
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

  it('alerts at 75, 90 and 100% of the included hours', () => {
    expect(DEFAULT_PLANS.team.warnAtPercent).toEqual([75, 90, 100])
  })
})

describe('per-minute overage price', () => {
  const team = DEFAULT_PLANS.team

  it('derives the Stripe per-minute unit_amount_decimal from the shared hourly rate', () => {
    expect(team.overageCentsPerHour).toBe(ORCA_CLOUD_OVERAGE_CENTS_PER_HOUR)
    // $1.00 per hour = 1.666666666667 cents per minute (Stripe's 12-decimal maximum).
    expect(overageUnitAmountDecimal(100)).toBe('1.666666666667')
    expect(overageUnitAmountDecimal(75)).toBe('1.250000000000')
    expect(overageUnitAmountDecimal(team.overageCentsPerHour).split('.')[1]).toHaveLength(12)
  })

  it('charges whole minutes, rounding up, like the price (transform_quantity divide_by 60, round up)', () => {
    expect(overageCents(team, 0)).toBe(0)
    expect(overageCents(team, 1)).toBe(2) // one started minute: 1.67 cents
    expect(overageCents(team, 60)).toBe(2)
    expect(overageCents(team, 61)).toBe(3) // two minutes: 3.33 cents
    expect(overageCents(team, 30 * 60)).toBe(50)
    expect(overageCents(team, HOUR)).toBe(100)
    expect(overageCents(team, 4 * HOUR)).toBe(400)
  })

  it('caps on whole minutes, so the invoice never passes the spend cap', () => {
    for (const cap of [0, 1, 99, 100, 101, 2500, 2501, 12_345, 500_000]) {
      const seconds = capSeconds(team, cap)
      expect(seconds % 60).toBe(0)
      expect(overageCents(team, seconds)).toBeLessThanOrEqual(cap)
      // ...and one more minute would pass it.
      expect(overageCents(team, seconds + 60)).toBeGreaterThan(cap)
    }
    // $25.01 doesn't pay for a 1,501st minute ($25.0167); $25.02 does.
    expect(capSeconds(team, 2501)).toBe(25 * HOUR)
    expect(capSeconds(team, 2502)).toBe(25 * HOUR + 60)
  })
})
