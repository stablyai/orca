// GET /v1/plans, GET /v1/entitlements, catalog prices from Stripe, and the legacy `offers` built
// from the D1 catalog when ENTITLEMENTS_MODE is on.
import { describe, expect, it } from 'vitest'
import { syncCatalogPrices } from '../src/catalog-sync'
import { publicOffers, DEFAULT_PLANS } from '../src/plans'
import { formatPrice } from '../src/plans-api'
import { createStripeClient } from '../src/stripe'
import { createHarness } from './harness'
import { checkoutCompleted } from './stripe-fake'

const HOUR = 3600
const PERIOD_START = Math.floor(Date.now() / 1000) - 5 * 24 * HOUR
const PERIOD_END = PERIOD_START + 30 * 24 * HOUR

async function resyncPrices(h: Awaited<ReturnType<typeof createHarness>>) {
  return syncCatalogPrices(h.env, createStripeClient(h.env, h.stripe.fetchImpl), Date.now())
}

describe('GET /v1/plans', () => {
  it('serves the catalog with Stripe prices, entitlements, features and policy; never price ids', async () => {
    const h = await createHarness()
    const response = await h.call('GET', '/v1/plans')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=300')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    const body = response.body
    expect(body.schemaVersion).toBe(1)
    expect(body.plans.map((plan: { id: string }) => plan.id)).toEqual(['trial', 'team', 'enterprise'])
    const team = body.plans.find((plan: { id: string }) => plan.id === 'team')
    expect(team).toMatchObject({
      kind: 'self_serve',
      name: 'Team',
      billing: 'per_seat',
      prices: [
        { interval: 'month', unitAmountCents: 5000, currency: 'usd' },
        { interval: 'year', unitAmountCents: 48000, currency: 'usd' }
      ],
      overage: { centsPerHour: 100, billedPer: 'minute', defaultSpendCapCents: 2500, maxSpendCapCents: 500_000 },
      seats: { min: 1, max: 500 },
      warnAtPercent: [75, 90, 100],
      entitlements: { sandbox_hours_monthly: { value: 60, perSeat: true }, max_concurrent_sandboxes: { value: 3, perSeat: true } },
      checkout: { available: true, intervals: ['month', 'year'] }
    })
    expect(team.version).toBe(2)
    expect(team.features.map((feature: { id: string }) => feature.id)).toEqual([
      'included_hours_per_seat',
      'sandbox_spec',
      'ready_in_seconds',
      'agents_keep_running',
      'idle_sleep',
      'overage_optional'
    ])
    expect(team).toHaveProperty('supportUrl')
    expect(team.features[0]).toEqual({ id: 'included_hours_per_seat', params: { hours: 60 }, text: '60 sandbox hours per seat each month, pooled across your team' })
    expect(body.plans.find((plan: { id: string }) => plan.id === 'enterprise')).toMatchObject({ kind: 'contact_sales', contactUrl: 'https://onorca.dev/contact-sales' })
    expect(body.plans.find((plan: { id: string }) => plan.id === 'trial')).toMatchObject({ kind: 'trial', entitlements: { sandbox_hours_lifetime: { value: 2, perSeat: false } } })
    expect(JSON.stringify(body)).not.toContain('price_')
  })

  it('answers 304 to a matching ETag, and the ETag changes when a Stripe price changes', async () => {
    const h = await createHarness()
    const first = await h.call('GET', '/v1/plans')
    const etag = first.headers.get('etag')!
    expect((await h.call('GET', '/v1/plans', { headers: { 'if-none-match': etag } })).status).toBe(304)
    h.stripe.prices.get('price_team_month')!.unit_amount = 5500
    await resyncPrices(h)
    const second = await h.call('GET', '/v1/plans', { headers: { 'if-none-match': etag } })
    expect(second.status).toBe(200)
    expect(second.body.plans.find((plan: { id: string }) => plan.id === 'team').prices[0].unitAmountCents).toBe(5500)
  })

  it('shows no price (and no checkout) for an interval Stripe has no price for: never a guessed one', async () => {
    const h = await createHarness({ ENTITLEMENTS_MODE: 'on' })
    h.stripe.prices.get('price_team_year')!.active = false
    h.raw.exec("UPDATE plan_prices SET active = 0 WHERE stripe_price_id = 'price_team_year'")
    const team = (await h.call('GET', '/v1/plans')).body.plans.find((plan: { id: string }) => plan.id === 'team')
    expect(team.prices.map((price: { interval: string }) => price.interval)).toEqual(['month'])
    expect(team.checkout).toEqual({ available: true, intervals: ['month'] })
    const token = await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'owner', email: 'a@example.com' })
    const auth = { authorization: `Bearer ${token}` }
    expect(await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team', interval: 'year' }, headers: auth })).toEqual({
      status: 409,
      body: { error: 'plan_unavailable' }
    })
    const offers = (await h.call('GET', '/v1/billing/entitlements', { headers: auth })).body.offers
    expect(offers.team).toMatchObject({ annualPriceCentsPerSeat: null, annualPriceLabel: '', monthlyPriceCentsPerSeat: 5000 })
  })

  it('fails closed (503) before a catalog was ever applied', async () => {
    const h = await createHarness()
    h.raw.exec('DELETE FROM plan_versions; DELETE FROM plans;')
    const { invalidateCatalog } = await import('../src/catalog')
    invalidateCatalog(h.env.BILLING_DB)
    expect(await h.call('GET', '/v1/plans')).toEqual({ status: 503, body: { error: 'billing_misconfigured' } })
  })
})

describe('catalog prices follow the Stripe lookup keys', () => {
  it('sells the new price once the lookup key moves; the old one stays as history', async () => {
    const h = await createHarness({ ENTITLEMENTS_MODE: 'on' })
    h.stripe.prices.get('price_team_month')!.lookup_key = null
    h.stripe.prices.set('price_team_month_v2', {
      id: 'price_team_month_v2',
      active: true,
      currency: 'usd',
      unit_amount: 6000,
      unit_amount_decimal: '6000',
      lookup_key: 'orca_team_seat_monthly',
      product: 'prod_team',
      recurring: { interval: 'month', usage_type: 'licensed' }
    })
    await resyncPrices(h)
    const rows = h.raw.prepare("SELECT stripe_price_id, is_checkout_price FROM plan_prices WHERE role = 'seat' AND interval = 'month' ORDER BY stripe_price_id").all()
    expect(rows).toEqual([
      { stripe_price_id: 'price_team_month', is_checkout_price: 0 },
      { stripe_price_id: 'price_team_month_v2', is_checkout_price: 1 }
    ])
    const token = await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'owner', email: 'a@example.com' })
    await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team' }, headers: { authorization: `Bearer ${token}` } })
    const session = h.stripe.calls.find((call) => call.path === '/v1/checkout/sessions' && call.method === 'POST')!
    expect(session.form.get('line_items[0][price]')).toBe('price_team_month_v2')
    const offers = (await h.call('GET', '/v1/billing/entitlements', { headers: { authorization: `Bearer ${token}` } })).body.offers
    expect(offers.team).toMatchObject({ monthlyPriceCentsPerSeat: 6000, monthlyPriceLabel: '$60 per seat per month' })
  })

  it('refreshes on a price.updated webhook', async () => {
    const h = await createHarness({ ENTITLEMENTS_MODE: 'on' })
    h.stripe.prices.get('price_team_year')!.unit_amount = 45000
    const { stripeEvent } = await import('./stripe-fake')
    expect((await h.webhook(stripeEvent('price.updated', { id: 'price_team_year', object: 'price' }))).body).toEqual({ received: true })
    const team = (await h.call('GET', '/v1/plans')).body.plans.find((plan: { id: string }) => plan.id === 'team')
    expect(team.prices[1]).toEqual({ interval: 'year', unitAmountCents: 45000, currency: 'usd' })
  })

  it('keeps the prices it has when the key may not read Prices (403), and says so', async () => {
    const h = await createHarness({ ENTITLEMENTS_MODE: 'on' })
    const forbidden: typeof fetch = async () => Response.json({ error: { message: 'restricted' } }, { status: 403 })
    const result = await syncCatalogPrices(h.env, createStripeClient(h.env, forbidden), Date.now())
    expect(result.error).toBe('stripe_403')
    const team = (await h.call('GET', '/v1/plans')).body.plans.find((plan: { id: string }) => plan.id === 'team')
    expect(team.prices).toHaveLength(2)
  })
})

describe('offers from the catalog (ENTITLEMENTS_MODE=on)', () => {
  it('match the legacy offers for the launch catalog, plus the warning levels', async () => {
    const h = await createHarness({ ENTITLEMENTS_MODE: 'on' })
    const token = await h.desktopToken({ sub: 'u1' })
    const offers = (await h.call('GET', '/v1/billing/entitlements', { headers: { authorization: `Bearer ${token}` } })).body.offers
    const { trial, ...rest } = offers
    expect(trial).toBeNull()
    const legacy = publicOffers({ team: DEFAULT_PLANS.team, enterprise: DEFAULT_PLANS.enterprise })
    expect(rest).toEqual({ ...legacy, team: { ...legacy.team, warnAtPercent: [75, 90, 100] } })
    const setup = (await h.call('GET', '/v1/cloud-setup/offers')).body
    expect(setup.team.monthlyPriceLabel).toBe('$50 per seat per month')
  })

  it('formats prices like the legacy labels', () => {
    expect(formatPrice(5000, 'usd')).toBe('$50')
    expect(formatPrice(48000, 'usd')).toBe('$480')
    expect(formatPrice(1250, 'usd')).toBe('$12.50')
    expect(formatPrice(100000, 'usd')).toBe('$1,000')
  })
})

describe('GET /v1/entitlements', () => {
  it('returns effective values, access and the grants behind them', async () => {
    const h = await createHarness({ ENTITLEMENTS_MODE: 'on' })
    const token = await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'owner', email: 'a@example.com' })
    const auth = { authorization: `Bearer ${token}` }
    expect((await h.call('GET', '/v1/entitlements')).status).toBe(401)
    expect((await h.call('GET', '/v1/entitlements', { headers: auth })).body).toMatchObject({
      schemaVersion: 1,
      subject: 'org:o1',
      source: 'grants',
      plan: null,
      access: { canStartSandbox: false, reason: 'no_subscription' },
      grants: [],
      canManageBilling: true
    })
    await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team', seats: 2 }, headers: auth })
    const customer = [...h.stripe.customers.keys()][0]!
    const subscription = h.stripe.putSubscription({ customer, accountId: 'org:o1', basePrice: 'price_team_month', quantity: 2, periodStart: PERIOD_START, periodEnd: PERIOD_END })
    await h.webhook(checkoutCompleted({ customer, subscription: subscription.id, accountId: 'org:o1' }))
    const view = await h.call('GET', '/v1/entitlements', { headers: auth })
    expect(view.headers.get('cache-control')).toBe('private, no-cache')
    expect(view.body).toMatchObject({
      plan: { id: 'team', name: 'Team', status: 'active', interval: 'month', seats: 2, cancelAtPeriodEnd: false },
      effective: {
        sandboxSeconds: { included: 120 * HOUR, used: 0, remaining: 120 * HOUR, resets: 'monthly' },
        maxConcurrentSandboxes: 6,
        maxConcurrentSandboxesPerMember: 3,
        machineSizes: ['standard', 'large']
      },
      access: { canStartSandbox: true, reason: null, suspendRunning: false }
    })
    expect(view.body.grants).toContainEqual({
      key: 'sandbox_hours_monthly',
      value: 60,
      perSeat: true,
      seats: 2,
      source: 'subscription',
      state: 'active',
      plan: { id: 'team', version: 2 },
      startsAt: PERIOD_START * 1000,
      endsAt: null
    })
  })
})
