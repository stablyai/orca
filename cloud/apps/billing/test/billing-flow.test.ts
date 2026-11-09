import { describe, expect, it } from 'vitest'
import { checkoutCompleted, invoiceEvent, stripeEvent } from './stripe-fake'
import { createHarness } from './harness'

const HOUR = 3600
const PERIOD_START = Math.floor(Date.now() / 1000) - 5 * 24 * HOUR
const PERIOD_END = PERIOD_START + 30 * 24 * HOUR

async function subscribedPro(options: { overage?: boolean } = {}) {
  const h = await createHarness()
  const token = await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'owner', email: 'a@example.com' })
  const checkout = await h.call('POST', '/v1/billing/checkout', { body: { plan: 'pro' }, headers: { authorization: `Bearer ${token}` } })
  expect(checkout.status).toBe(200)
  const customer = [...h.stripe.customers.keys()][0]!
  const subscription = h.stripe.putSubscription({
    customer,
    accountId: 'org:o1',
    basePrice: 'price_pro',
    overagePrice: options.overage === false ? undefined : 'price_overage',
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END
  })
  expect((await h.webhook(checkoutCompleted({ customer, subscription: subscription.id, accountId: 'org:o1' }))).body).toEqual({
    received: true
  })
  return { h, token, customer, subscription }
}

function usage(id: string, hours: number, extra: Record<string, unknown> = {}) {
  const endedAt = Date.now() - 60_000
  return { usageId: id, accountId: 'org:o1', sandboxId: 'sbx_1', machineSize: 'standard', startedAt: endedAt - hours * HOUR * 1000, endedAt, ...extra }
}

describe('checkout and portal', () => {
  it('creates one customer per account and a subscription-mode Checkout with the overage price', async () => {
    const h = await createHarness()
    const token = await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'admin', email: 'a@example.com' })
    const auth = { authorization: `Bearer ${token}` }
    const first = await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team', seats: 4 }, headers: auth })
    expect(first.status).toBe(200)
    expect(first.body.url).toMatch(/^https:\/\/checkout\.stripe\.com\//)
    await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team', seats: 4 }, headers: auth })
    expect(h.stripe.customers.size).toBe(1)

    const session = h.stripe.calls.find((call) => call.path === '/v1/checkout/sessions')!
    expect(session.form.get('mode')).toBe('subscription')
    expect(session.form.get('line_items[0][price]')).toBe('price_team')
    expect(session.form.get('line_items[0][quantity]')).toBe('4')
    expect(session.form.get('line_items[1][price]')).toBe('price_overage')
    expect(session.form.has('line_items[1][quantity]')).toBe(false)
    expect(session.form.get('subscription_data[metadata][account_id]')).toBe('org:o1')
    expect(session.form.get('payment_method_collection')).toBe('always')
    expect(session.form.get('success_url')).toContain('session_id={CHECKOUT_SESSION_ID}')
    expect(session.headers.get('idempotency-key')).toMatch(/^checkout:org:o1:/)
  })

  it('lets only org owners and admins buy or manage the plan; personal accounts manage themselves', async () => {
    const h = await createHarness()
    const member = await h.desktopToken({ sub: 'u2', org: 'o1', orgRole: 'member' })
    const denied = await h.call('POST', '/v1/billing/checkout', { body: { plan: 'pro' }, headers: { authorization: `Bearer ${member}` } })
    expect(denied).toEqual({ status: 403, body: { error: 'billing_admin_required' } })
    const portal = await h.call('POST', '/v1/billing/portal', { headers: { authorization: `Bearer ${member}` } })
    expect(portal.status).toBe(403)

    const solo = await h.desktopToken({ sub: 'u3' })
    const ok = await h.call('POST', '/v1/billing/checkout', { body: { plan: 'max' }, headers: { authorization: `Bearer ${solo}` } })
    expect(ok.status).toBe(200)
    expect(h.stripe.customers.values().next().value?.metadata.account_id).toBe('user:u3')
  })

  it('rejects bad tokens, bad bodies and a second subscription', async () => {
    const { h, token } = await subscribedPro()
    const wrongAudience = await h.desktopToken({ sub: 'u1' }, { audience: 'orca-relay' })
    const wrongPurpose = await h.desktopToken({ sub: 'u1' }, { purpose: 'host-control' })
    const tooOld = await h.desktopToken({ sub: 'u1' }, { ageSeconds: 20 * 60 })
    for (const bad of [wrongAudience, wrongPurpose, tooOld, 'garbage']) {
      expect((await h.call('GET', '/v1/billing/entitlements', { headers: { authorization: `Bearer ${bad}` } })).status).toBe(401)
    }
    expect((await h.call('GET', '/v1/billing/entitlements')).status).toBe(401)
    const auth = { authorization: `Bearer ${token}` }
    expect((await h.call('POST', '/v1/billing/checkout', { body: { plan: 'free' }, headers: auth })).status).toBe(400)
    expect((await h.call('POST', '/v1/billing/checkout', { body: { plan: 'pro', extra: 1 }, headers: auth })).status).toBe(400)
    expect(await h.call('POST', '/v1/billing/checkout', { body: { plan: 'max' }, headers: auth })).toEqual({
      status: 409,
      body: { error: 'already_subscribed' }
    })
  })

  it('opens the portal for the linked customer only', async () => {
    const { h, token, customer } = await subscribedPro()
    const portal = await h.call('POST', '/v1/billing/portal', { headers: { authorization: `Bearer ${token}` } })
    expect(portal.body.url).toMatch(/^https:\/\/billing\.stripe\.com\//)
    expect(h.stripe.calls.find((call) => call.path === '/v1/billing_portal/sessions')?.form.get('customer')).toBe(customer)
    const stranger = await h.desktopToken({ sub: 'u9' })
    expect(await h.call('POST', '/v1/billing/portal', { headers: { authorization: `Bearer ${stranger}` } })).toEqual({
      status: 404,
      body: { error: 'no_billing_account' }
    })
  })
})

describe('webhooks', () => {
  it('rejects unsigned or mis-signed deliveries without touching state', async () => {
    const { h, subscription, customer } = await subscribedPro()
    const event = invoiceEvent('invoice.paid', subscription.id, customer)
    expect((await h.call('POST', '/v1/stripe/webhook', { rawBody: JSON.stringify(event) })).status).toBe(400)
    expect((await h.webhook(event, 'whsec_wrong')).body).toEqual({ error: 'signature_mismatch' })
    expect(h.raw.prepare('SELECT COUNT(*) AS n FROM stripe_events WHERE event_id = ?').get(event.id)).toEqual({ n: 0 })
  })

  it('processes an event id once', async () => {
    const { h, subscription, customer } = await subscribedPro()
    const event = invoiceEvent('invoice.paid', subscription.id, customer)
    expect((await h.webhook(event)).body).toEqual({ received: true })
    const reads = h.stripe.calls.filter((call) => call.method === 'GET').length
    expect((await h.webhook(event)).body).toEqual({ duplicate: true })
    expect(h.stripe.calls.filter((call) => call.method === 'GET').length).toBe(reads)
  })

  it('applies Stripe current state, so out-of-order deliveries cannot resurrect a canceled plan', async () => {
    const { h, token, subscription, customer } = await subscribedPro()
    const staleUpdate = stripeEvent('customer.subscription.updated', { ...subscription, status: 'active' })
    subscription.status = 'canceled'
    await h.webhook(stripeEvent('customer.subscription.deleted', { ...subscription }))
    await h.webhook(staleUpdate)
    const entitlement = await h.call('GET', '/v1/billing/entitlements', { headers: { authorization: `Bearer ${token}` } })
    expect(entitlement.body).toMatchObject({ status: 'canceled', canStartSandbox: false, reason: 'subscription_inactive' })
    expect(customer).toBeTruthy()
  })

  it('marks past_due from invoice.payment_failed (new invoice.parent shape)', async () => {
    const { h, token, subscription, customer } = await subscribedPro()
    subscription.status = 'past_due'
    expect((await h.webhook(invoiceEvent('invoice.payment_failed', subscription.id, customer))).body).toEqual({ received: true })
    const entitlement = await h.call('GET', '/v1/billing/entitlements', { headers: { authorization: `Bearer ${token}` } })
    expect(entitlement.body).toMatchObject({ status: 'past_due', canStartSandbox: false, reason: 'payment_past_due' })
  })

  it('acknowledges but ignores live-mode events and subscriptions on customers it did not create', async () => {
    const { h, subscription } = await subscribedPro()
    expect((await h.webhook(stripeEvent('customer.subscription.updated', subscription, { livemode: true }))).body).toEqual({
      ignored: 'livemode'
    })
    const foreign = h.stripe.putSubscription({
      customer: 'cus_someone_else',
      accountId: 'org:o1',
      basePrice: 'price_max',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END
    })
    // Metadata naming org:o1 is not enough: the customer must be the one billing created for it.
    expect((await h.webhook(stripeEvent('customer.subscription.created', foreign))).body).toEqual({ ignored: 'unknown_customer' })
    expect(h.raw.prepare('SELECT plan FROM subscriptions WHERE account_id = ?').all('org:o1')).toEqual([{ plan: 'pro' }])
  })

  it('returns 500 (so Stripe retries) when Stripe cannot be read, and succeeds on redelivery', async () => {
    const { h, subscription, customer } = await subscribedPro()
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

describe('entitlements and usage', () => {
  it('reports hours used and remaining for the desktop', async () => {
    const { h, token } = await subscribedPro()
    expect((await h.controlPlane('/v1/internal/usage', usage('u-1', 10))).status).toBe(200)
    const entitlement = await h.call('GET', '/v1/billing/entitlements', { headers: { authorization: `Bearer ${token}` } })
    expect(entitlement.body).toMatchObject({
      accountId: 'org:o1',
      plan: 'pro',
      planLabel: 'Pro',
      status: 'active',
      includedSeconds: 50 * HOUR,
      usedSeconds: 10 * HOUR,
      remainingIncludedSeconds: 40 * HOUR,
      overageSeconds: 0,
      canStartSandbox: true,
      canManageBilling: true,
      period: { start: PERIOD_START * 1000, end: PERIOD_END * 1000 }
    })
  })

  it('is idempotent per usageId and weights larger machines', async () => {
    const { h } = await subscribedPro()
    const first = await h.controlPlane('/v1/internal/usage', usage('u-1', 1, { machineSize: 'large' }))
    const again = await h.controlPlane('/v1/internal/usage', usage('u-1', 1, { machineSize: 'large' }))
    expect(first.body).toMatchObject({ recorded: true, weightedSeconds: 2 * HOUR })
    expect(again.body).toMatchObject({ recorded: false })
    expect(h.raw.prepare('SELECT SUM(weighted_seconds) AS s FROM usage_events').get()).toEqual({ s: 2 * HOUR })
  })

  it('meters only the overage past included hours to Stripe, once per segment', async () => {
    const { h, customer } = await subscribedPro()
    await h.controlPlane('/v1/internal/usage', usage('u-1', 24))
    await h.controlPlane('/v1/internal/usage', usage('u-2', 24))
    const crossing = await h.controlPlane('/v1/internal/usage', usage('u-3', 4))
    expect(crossing.body).toMatchObject({ overageSeconds: 2 * HOUR, canStartSandbox: true })
    await h.controlPlane('/v1/internal/usage', usage('u-3', 4))
    expect(h.stripe.meterEvents).toEqual([
      expect.objectContaining({
        event_name: 'orca_sandbox_seconds',
        identifier: 'u-3',
        'payload[stripe_customer_id]': customer,
        'payload[value]': String(2 * HOUR)
      })
    ])
  })

  it('retries failed meter reports from the outbox', async () => {
    const { h } = await subscribedPro()
    const env = h.env
    await h.controlPlane('/v1/internal/usage', usage('u-1', 24))
    await h.controlPlane('/v1/internal/usage', usage('u-2', 24))
    h.stripe.failNextMeterEvents(1)
    await h.controlPlane('/v1/internal/usage', usage('u-3', 4))
    expect(h.stripe.meterEvents).toHaveLength(0)
    expect(h.raw.prepare('SELECT status, attempts FROM meter_reports').get()).toEqual({ status: 'pending', attempts: 1 })
    const { flushMeterReports } = await import('../src/usage')
    const { createStripeClient } = await import('../src/stripe')
    expect(await flushMeterReports(env, createStripeClient(env, h.stripe.fetchImpl), Date.now())).toEqual({ sent: 1, failed: 0 })
    expect(h.stripe.meterEvents[0]?.['payload[value]']).toBe(String(2 * HOUR))
  })

  it('stops new starts when included hours run out without overage, or at the overage cap', async () => {
    const noOverage = await subscribedPro({ overage: false })
    expect((await noOverage.h.controlPlane('/v1/internal/usage', usage('u-1', 24))).status).toBe(200)
    await noOverage.h.controlPlane('/v1/internal/usage', usage('u-2', 24))
    const third = await noOverage.h.controlPlane('/v1/internal/usage', usage('u-3', 3))
    expect(third.body).toMatchObject({ canStartSandbox: false, reason: 'included_hours_exhausted' })
    expect(noOverage.h.stripe.meterEvents).toHaveLength(0)

    const capped = await subscribedPro()
    for (let i = 0; i < 7; i++) {
      await capped.h.controlPlane('/v1/internal/usage', usage(`c-${i}`, 22))
    }
    const check = await capped.h.controlPlane('/v1/internal/entitlements/check', { accountId: 'org:o1', machineSize: 'standard', runningSandboxes: 0 })
    expect(check.body).toMatchObject({ allow: false, reason: 'overage_cap_reached' })
  })

  it('gates starts by machine size and concurrency for the control plane', async () => {
    const { h } = await subscribedPro()
    const check = (body: Record<string, unknown>) => h.controlPlane('/v1/internal/entitlements/check', { accountId: 'org:o1', ...body })
    expect((await check({ machineSize: 'standard', runningSandboxes: 1 })).body).toMatchObject({ allow: true, reason: null })
    expect((await check({ machineSize: 'large', runningSandboxes: 0 })).body).toMatchObject({ allow: false, reason: 'machine_size_not_in_plan' })
    expect((await check({ machineSize: 'standard', runningSandboxes: 2 })).body).toMatchObject({ allow: false, reason: 'concurrency_limit' })
    const unknown = await h.controlPlane('/v1/internal/entitlements/check', { accountId: 'org:nobody', machineSize: 'standard', runningSandboxes: 0 })
    expect(unknown.body).toMatchObject({ allow: false, reason: 'no_subscription' })
  })

  it('pools Team hours across seats', async () => {
    const h = await createHarness()
    const token = await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'owner' })
    await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team', seats: 3 }, headers: { authorization: `Bearer ${token}` } })
    const customer = [...h.stripe.customers.keys()][0]!
    const sub = h.stripe.putSubscription({ customer, accountId: 'org:o1', basePrice: 'price_team', overagePrice: 'price_overage', quantity: 3, periodStart: PERIOD_START, periodEnd: PERIOD_END })
    await h.webhook(stripeEvent('customer.subscription.created', sub))
    const entitlement = await h.call('GET', '/v1/billing/entitlements', { headers: { authorization: `Bearer ${token}` } })
    expect(entitlement.body).toMatchObject({ plan: 'team', seats: 3, includedSeconds: 450 * HOUR })
  })

  it('authenticates the control plane and validates segments', async () => {
    const { h } = await subscribedPro()
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
    expect(await h.call('POST', '/v1/billing/checkout', { body: { plan: 'pro' }, headers: { authorization: `Bearer ${token}` } })).toEqual({
      status: 503,
      body: { error: 'billing_misconfigured' }
    })
  })
})
