import { describe, expect, it } from 'vitest'
import { checkoutCompleted, invoiceEvent, stripeEvent } from './stripe-fake'
import { createHarness } from './harness'

const HOUR = 3600
const PERIOD_START = Math.floor(Date.now() / 1000) - 5 * 24 * HOUR
const PERIOD_END = PERIOD_START + 30 * 24 * HOUR

/** A 2-seat monthly Team org (120 included hours, 6 concurrent), optionally opted in to overage. */
async function subscribedTeam(options: { seats?: number; overage?: boolean; spendCapCents?: number } = {}) {
  const h = await createHarness()
  const token = await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'owner', email: 'a@example.com' })
  const auth = { authorization: `Bearer ${token}` }
  const seats = options.seats ?? 2
  const checkout = await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team', seats }, headers: auth })
  expect(checkout.status).toBe(200)
  const customer = [...h.stripe.customers.keys()][0]!
  const subscription = h.stripe.putSubscription({
    customer,
    accountId: 'org:o1',
    basePrice: 'price_team_month',
    quantity: seats,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END
  })
  expect((await h.webhook(checkoutCompleted({ customer, subscription: subscription.id, accountId: 'org:o1' }))).body).toEqual({
    received: true
  })
  if (options.overage) {
    const body = options.spendCapCents === undefined ? { enabled: true } : { enabled: true, spendCapCents: options.spendCapCents }
    expect((await h.call('POST', '/v1/billing/overage', { body, headers: auth })).status).toBe(200)
  }
  return { h, token, auth, customer, subscription }
}

function usage(id: string, hours: number, extra: Record<string, unknown> = {}) {
  const endedAt = Date.now() - 60_000
  return { usageId: id, accountId: 'org:o1', sandboxId: 'sbx_1', machineSize: 'standard', startedAt: endedAt - hours * HOUR * 1000, endedAt, ...extra }
}

describe('checkout and portal', () => {
  it('creates one customer per account and a seat-quantity Checkout without overage', async () => {
    const h = await createHarness()
    const token = await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'admin', email: 'a@example.com' })
    const auth = { authorization: `Bearer ${token}` }
    const first = await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team', seats: 4, interval: 'year' }, headers: auth })
    expect(first.status).toBe(200)
    expect(first.body.url).toMatch(/^https:\/\/checkout\.stripe\.com\//)
    await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team', seats: 4 }, headers: auth })
    expect(h.stripe.customers.size).toBe(1)

    const [annual, monthly] = h.stripe.calls.filter((call) => call.path === '/v1/checkout/sessions')
    expect(annual!.form.get('mode')).toBe('subscription')
    expect(annual!.form.get('line_items[0][price]')).toBe('price_team_year')
    expect(monthly!.form.get('line_items[0][price]')).toBe('price_team_month')
    expect(annual!.form.get('line_items[0][quantity]')).toBe('4')
    expect(annual!.form.has('line_items[0][adjustable_quantity][enabled]')).toBe(false)
    expect(annual!.form.has('line_items[1][price]')).toBe(false)
    expect(annual!.form.get('subscription_data[metadata][account_id]')).toBe('org:o1')
    expect(annual!.form.has('subscription_data[trial_period_days]')).toBe(false)
    expect(annual!.form.get('payment_method_collection')).toBe('always')
    expect(annual!.form.get('success_url')).toContain('session_id={CHECKOUT_SESSION_ID}')
    expect(annual!.headers.get('idempotency-key')).toMatch(/^checkout:org:o1:/)
  })

  it('lets only org owners and admins buy or manage the plan; personal accounts manage themselves', async () => {
    const h = await createHarness()
    const member = await h.desktopToken({ sub: 'u2', org: 'o1', orgRole: 'member' })
    const auth = { authorization: `Bearer ${member}` }
    expect(await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team' }, headers: auth })).toEqual({
      status: 403,
      body: { error: 'billing_admin_required' }
    })
    expect((await h.call('POST', '/v1/billing/portal', { headers: auth })).status).toBe(403)
    expect((await h.call('POST', '/v1/billing/overage', { body: { enabled: true }, headers: auth })).status).toBe(403)

    const solo = await h.desktopToken({ sub: 'u3' })
    expect((await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team' }, headers: { authorization: `Bearer ${solo}` } })).status).toBe(200)
    expect(h.stripe.customers.values().next().value?.metadata.account_id).toBe('user:u3')
  })

  it('rejects bad tokens, unknown plans and a second subscription', async () => {
    const { h, auth } = await subscribedTeam()
    const wrongAudience = await h.desktopToken({ sub: 'u1' }, { audience: 'orca-relay' })
    const wrongPurpose = await h.desktopToken({ sub: 'u1' }, { purpose: 'host-control' })
    const tooOld = await h.desktopToken({ sub: 'u1' }, { ageSeconds: 20 * 60 })
    for (const bad of [wrongAudience, wrongPurpose, tooOld, 'garbage']) {
      expect((await h.call('GET', '/v1/billing/entitlements', { headers: { authorization: `Bearer ${bad}` } })).status).toBe(401)
    }
    expect((await h.call('GET', '/v1/billing/entitlements')).status).toBe(401)
    for (const body of [{ plan: 'pro' }, { plan: 'enterprise' }, { plan: 'team', interval: 'week' }, { plan: 'team', seats: 0 }]) {
      expect((await h.call('POST', '/v1/billing/checkout', { body, headers: auth })).status).toBe(400)
    }
    expect(await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team' }, headers: auth })).toEqual({
      status: 409,
      body: { error: 'already_subscribed' }
    })
  })

  it('opens the portal (with the configured portal configuration) for the linked customer only', async () => {
    const { h, auth, customer } = await subscribedTeam()
    h.env.STRIPE_PORTAL_CONFIGURATION = 'bpc_test_1'
    const portal = await h.call('POST', '/v1/billing/portal', { headers: auth })
    expect(portal.body.url).toMatch(/^https:\/\/billing\.stripe\.com\//)
    const call = h.stripe.calls.find((entry) => entry.path === '/v1/billing_portal/sessions')!
    expect(call.form.get('customer')).toBe(customer)
    expect(call.form.get('configuration')).toBe('bpc_test_1')
    const stranger = await h.desktopToken({ sub: 'u9' })
    expect(await h.call('POST', '/v1/billing/portal', { headers: { authorization: `Bearer ${stranger}` } })).toEqual({
      status: 404,
      body: { error: 'no_billing_account' }
    })
  })
})

describe('webhooks', () => {
  it('rejects unsigned or mis-signed deliveries without touching state', async () => {
    const { h, subscription, customer } = await subscribedTeam()
    const event = invoiceEvent('invoice.paid', subscription.id, customer)
    expect((await h.call('POST', '/v1/stripe/webhook', { rawBody: JSON.stringify(event) })).status).toBe(400)
    expect((await h.webhook(event, 'whsec_wrong')).body).toEqual({ error: 'signature_mismatch' })
    expect(h.raw.prepare('SELECT COUNT(*) AS n FROM stripe_events WHERE event_id = ?').get(event.id)).toEqual({ n: 0 })
  })

  it('processes an event id once', async () => {
    const { h, subscription, customer } = await subscribedTeam()
    const event = invoiceEvent('invoice.paid', subscription.id, customer)
    expect((await h.webhook(event)).body).toEqual({ received: true })
    const reads = h.stripe.calls.filter((call) => call.method === 'GET').length
    expect((await h.webhook(event)).body).toEqual({ duplicate: true })
    expect(h.stripe.calls.filter((call) => call.method === 'GET').length).toBe(reads)
  })

  it('applies Stripe current state, so out-of-order deliveries cannot resurrect a canceled plan', async () => {
    const { h, auth, subscription } = await subscribedTeam()
    const staleUpdate = stripeEvent('customer.subscription.updated', { ...subscription, status: 'active' })
    subscription.status = 'canceled'
    await h.webhook(stripeEvent('customer.subscription.deleted', { ...subscription }))
    await h.webhook(staleUpdate)
    const entitlement = await h.call('GET', '/v1/billing/entitlements', { headers: auth })
    expect(entitlement.body).toMatchObject({ status: 'canceled', canStartSandbox: false, reason: 'subscription_inactive' })
  })

  it('tracks seat and interval changes made in the portal', async () => {
    const { h, auth, subscription } = await subscribedTeam()
    subscription.items.data[0]!.quantity = 5
    subscription.items.data[0]!.price = { id: 'price_team_year' }
    subscription.items.data[0]!.current_period_end = PERIOD_START + 365 * 24 * HOUR
    await h.webhook(stripeEvent('customer.subscription.updated', subscription))
    const entitlement = await h.call('GET', '/v1/billing/entitlements', { headers: auth })
    expect(entitlement.body).toMatchObject({ seats: 5, interval: 'year', includedSeconds: 300 * HOUR })
    expect(entitlement.body.limits).toMatchObject({ maxConcurrentSandboxes: 15, idleSleepMinutes: 15 })
    // Annual plans still get a monthly allowance window.
    const window = entitlement.body.usageWindow
    expect(window.end - window.start).toBeLessThanOrEqual(31 * 24 * HOUR * 1000)
  })

  it('marks past_due from invoice.payment_failed (new invoice.parent shape)', async () => {
    const { h, auth, subscription, customer } = await subscribedTeam()
    subscription.status = 'past_due'
    expect((await h.webhook(invoiceEvent('invoice.payment_failed', subscription.id, customer))).body).toEqual({ received: true })
    const entitlement = await h.call('GET', '/v1/billing/entitlements', { headers: auth })
    expect(entitlement.body).toMatchObject({ status: 'past_due', canStartSandbox: false, reason: 'payment_past_due' })
  })

  it('acknowledges but ignores live-mode events and subscriptions on customers it did not create', async () => {
    const { h, subscription } = await subscribedTeam()
    expect((await h.webhook(stripeEvent('customer.subscription.updated', subscription, { livemode: true }))).body).toEqual({
      ignored: 'livemode'
    })
    const foreign = h.stripe.putSubscription({
      customer: 'cus_someone_else',
      accountId: 'org:o1',
      basePrice: 'price_team_year',
      quantity: 50,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END
    })
    // Metadata naming org:o1 is not enough: the customer must be the one billing created for it.
    expect((await h.webhook(stripeEvent('customer.subscription.created', foreign))).body).toEqual({ ignored: 'unknown_customer' })
    expect(h.raw.prepare('SELECT seats FROM subscriptions WHERE account_id = ?').all('org:o1')).toEqual([{ seats: 2 }])
  })

  it('returns 500 (so Stripe retries) when Stripe cannot be read, and succeeds on redelivery', async () => {
    const { h, subscription, customer } = await subscribedTeam()
    const event = invoiceEvent('invoice.paid', 'sub_missing', customer)
    expect((await h.webhook(event)).status).toBe(500)
    h.stripe.subscriptions.set('sub_missing', { ...subscription, id: 'sub_missing' })
    expect((await h.webhook(event)).body).toEqual({ received: true })
  })

  it('ignores event types it does not handle', async () => {
    const h = await createHarness()
    expect((await h.webhook(stripeEvent('customer.created', { id: 'cus_1' }))).body).toEqual({ ignored: 'event_type' })
  })
})

describe('entitlements, overage and usage', () => {
  it('reports pooled hours, warnings and limits for the desktop', async () => {
    const { h, auth } = await subscribedTeam()
    expect((await h.controlPlane('/v1/internal/usage', usage('u-1', 10))).status).toBe(200)
    const entitlement = await h.call('GET', '/v1/billing/entitlements', { headers: auth })
    expect(entitlement.body).toMatchObject({
      accountId: 'org:o1',
      plan: 'team',
      planLabel: 'Team',
      status: 'active',
      interval: 'month',
      seats: 2,
      includedSeconds: 120 * HOUR,
      usedSeconds: 10 * HOUR,
      remainingIncludedSeconds: 110 * HOUR,
      usageWarningPercent: null,
      overage: { optedIn: false, active: false, spendCapCents: 2500, spentCents: 0, centsPerHour: 75 },
      limits: { maxConcurrentSandboxes: 6, machineSizes: ['standard', 'large'], idleSleepMinutes: 15 },
      canStartSandbox: true,
      canManageBilling: true,
      period: { start: PERIOD_START * 1000, end: PERIOD_END * 1000 }
    })
    expect(entitlement.body.offers.team).toMatchObject({ monthlyPriceLabel: '$50/seat/mo', annualPriceLabel: '$480/seat/yr' })
    expect(entitlement.body.offers.enterprise).toMatchObject({ label: 'Enterprise', priceLabel: 'Custom' })

    for (let i = 0; i < 4; i++) {
      await h.controlPlane('/v1/internal/usage', usage(`w-${i}`, 22))
    }
    expect((await h.call('GET', '/v1/billing/entitlements', { headers: auth })).body.usageWarningPercent).toBe(80)
  })

  it('is idempotent per usageId and burns Large at 2x', async () => {
    const { h } = await subscribedTeam()
    const first = await h.controlPlane('/v1/internal/usage', usage('u-1', 1, { machineSize: 'large' }))
    const again = await h.controlPlane('/v1/internal/usage', usage('u-1', 1, { machineSize: 'large' }))
    expect(first.body).toMatchObject({ recorded: true, weightedSeconds: 2 * HOUR })
    expect(again.body).toMatchObject({ recorded: false })
    expect(h.raw.prepare('SELECT SUM(weighted_seconds) AS s FROM usage_events').get()).toEqual({ s: 2 * HOUR })
  })

  it('without opt-in, stops new starts at the included hours and meters nothing', async () => {
    const { h, auth } = await subscribedTeam()
    for (let i = 0; i < 5; i++) {
      await h.controlPlane('/v1/internal/usage', usage(`u-${i}`, 24))
    }
    const entitlement = await h.call('GET', '/v1/billing/entitlements', { headers: auth })
    expect(entitlement.body).toMatchObject({ usageWarningPercent: 100, canStartSandbox: false, reason: 'included_hours_exhausted' })
    expect(h.stripe.meterEvents).toHaveLength(0)
    expect(h.stripe.calls.some((call) => call.path === '/v1/subscription_items')).toBe(false)
  })

  it('opting in adds the metered item once, then meters only the overage past included hours', async () => {
    const { h, auth, customer, subscription } = await subscribedTeam({ overage: true })
    expect(subscription.items.data.map((item) => item.price.id)).toEqual(['price_team_month', 'price_overage'])
    await h.call('POST', '/v1/billing/overage', { body: { enabled: true }, headers: auth })
    expect(h.stripe.calls.filter((call) => call.path === '/v1/subscription_items')).toHaveLength(1)
    // The item's webhook must not drop the item id.
    await h.webhook(stripeEvent('customer.subscription.updated', subscription))

    for (let i = 0; i < 5; i++) {
      await h.controlPlane('/v1/internal/usage', usage(`u-${i}`, 24))
    }
    // Exactly the 120 included hours: nothing billable yet.
    expect(h.stripe.meterEvents).toHaveLength(0)
    const crossing = await h.controlPlane('/v1/internal/usage', usage('u-5', 4))
    expect(crossing.body).toMatchObject({ overageSeconds: 4 * HOUR, canStartSandbox: true })
    await h.controlPlane('/v1/internal/usage', usage('u-5', 4))
    expect(h.stripe.meterEvents).toEqual([
      expect.objectContaining({ identifier: 'u-5', 'payload[stripe_customer_id]': customer, 'payload[value]': String(4 * HOUR) })
    ])
    const entitlement = await h.call('GET', '/v1/billing/entitlements', { headers: auth })
    expect(entitlement.body.overage).toMatchObject({ optedIn: true, active: true, spentCents: 300 })
  })

  it('stops metering and new starts at the spend cap; admins can raise it', async () => {
    // $3 cap = 4 overage hours at $0.75.
    const { h, auth } = await subscribedTeam({ overage: true, spendCapCents: 300 })
    for (let i = 0; i < 5; i++) {
      await h.controlPlane('/v1/internal/usage', usage(`u-${i}`, 24))
    }
    await h.controlPlane('/v1/internal/usage', usage('o-1', 6))
    expect(h.stripe.meterEvents.map((event) => event['payload[value]'])).toEqual([String(4 * HOUR)])
    const check = () => h.controlPlane('/v1/internal/entitlements/check', { accountId: 'org:o1', machineSize: 'standard', runningSandboxes: 0 })
    expect((await check()).body).toMatchObject({ allow: false, reason: 'overage_cap_reached' })

    expect((await h.call('POST', '/v1/billing/overage', { body: { enabled: true, spendCapCents: 10_000_000 }, headers: auth })).body).toEqual({
      error: 'spend_cap_too_high'
    })
    await h.call('POST', '/v1/billing/overage', { body: { enabled: true, spendCapCents: 2500 }, headers: auth })
    expect((await check()).body).toMatchObject({ allow: true })
  })

  it('opting out stops metering immediately and blocks starts past included hours', async () => {
    const { h, auth } = await subscribedTeam({ overage: true })
    await h.call('POST', '/v1/billing/overage', { body: { enabled: false }, headers: auth })
    for (let i = 0; i < 6; i++) {
      await h.controlPlane('/v1/internal/usage', usage(`u-${i}`, 24))
    }
    expect(h.stripe.meterEvents).toHaveLength(0)
    expect((await h.call('GET', '/v1/billing/entitlements', { headers: auth })).body).toMatchObject({ reason: 'included_hours_exhausted' })
  })

  it('retries failed meter reports from the outbox', async () => {
    const { h } = await subscribedTeam({ overage: true })
    for (let i = 0; i < 5; i++) {
      await h.controlPlane('/v1/internal/usage', usage(`u-${i}`, 24))
    }
    h.stripe.failNextMeterEvents(1)
    await h.controlPlane('/v1/internal/usage', usage('u-9', 2))
    expect(h.stripe.meterEvents).toHaveLength(0)
    expect(h.raw.prepare('SELECT status, attempts FROM meter_reports').get()).toEqual({ status: 'pending', attempts: 1 })
    const { flushMeterReports } = await import('../src/usage')
    const { createStripeClient } = await import('../src/stripe')
    expect(await flushMeterReports(h.env, createStripeClient(h.env, h.stripe.fetchImpl), Date.now())).toEqual({ sent: 1, failed: 0 })
    expect(h.stripe.meterEvents[0]?.['payload[value]']).toBe(String(2 * HOUR))
  })

  it('gates starts by machine size and per-seat concurrency for the control plane', async () => {
    const { h } = await subscribedTeam()
    const check = (body: Record<string, unknown>) => h.controlPlane('/v1/internal/entitlements/check', { accountId: 'org:o1', ...body })
    expect((await check({ machineSize: 'large', runningSandboxes: 5 })).body).toMatchObject({ allow: true, reason: null, seats: 2, maxConcurrentSandboxes: 6, maxConcurrentSandboxesPerMember: 3 })
    expect((await check({ machineSize: 'standard', runningSandboxes: 6 })).body).toMatchObject({ allow: false, reason: 'concurrency_limit' })
    expect((await check({ machineSize: 'xlarge', runningSandboxes: 0 })).status).toBe(400)
    const unknown = await h.controlPlane('/v1/internal/entitlements/check', { accountId: 'org:nobody', machineSize: 'standard', runningSandboxes: 0 })
    expect(unknown.body).toMatchObject({ allow: false, reason: 'no_subscription' })
  })

  it('refuses overage opt-in without an open subscription', async () => {
    const h = await createHarness()
    const token = await h.desktopToken({ sub: 'u1' })
    expect(await h.call('POST', '/v1/billing/overage', { body: { enabled: true }, headers: { authorization: `Bearer ${token}` } })).toEqual({
      status: 409,
      body: { error: 'no_subscription' }
    })
  })

  it('authenticates the control plane and validates segments', async () => {
    const { h } = await subscribedTeam()
    expect((await h.controlPlane('/v1/internal/usage', usage('u-1', 1), 'cp_test_wrong_but_long_enough_000000000')).status).toBe(401)
    const desktop = await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'owner' })
    expect((await h.controlPlane('/v1/internal/usage', usage('u-1', 1), desktop)).status).toBe(401)
    expect((await h.controlPlane('/v1/internal/usage', usage('u-1', 25))).body).toEqual({ error: 'segment_too_long' })
    expect((await h.controlPlane('/v1/internal/usage', usage('u-1', 0))).body).toEqual({ error: 'empty_segment' })
    const future = Date.now() + 3600_000
    expect((await h.controlPlane('/v1/internal/usage', usage('u-1', 1, { startedAt: future - 1000, endedAt: future }))).body).toEqual({
      error: 'segment_in_future'
    })
    expect((await h.controlPlane('/v1/internal/usage', { ...usage('u-1', 1), accountId: 'org:o1; DROP' })).status).toBe(400)
  })

  it('refuses to run with a live Stripe key', async () => {
    const h = await createHarness({ STRIPE_SECRET_KEY: 'sk_live_nope' })
    const token = await h.desktopToken({ sub: 'u1' })
    expect(await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team' }, headers: { authorization: `Bearer ${token}` } })).toEqual({
      status: 503,
      body: { error: 'billing_misconfigured' }
    })
  })
})
