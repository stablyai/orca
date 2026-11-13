// Stripe lifecycle -> grants: price changes can't orphan a subscriber (the planForPrice bug),
// pause/resume, deleted customers, and reconciliation (event replay, rolling re-sync).
import { describe, expect, it } from 'vitest'
import { syncCatalogPrices } from '../src/catalog-sync'
import { reconcile, RESYNC_AFTER_MS } from '../src/reconcile'
import { createStripeClient } from '../src/stripe'
import { syncSubscription } from '../src/webhook'
import { createHarness } from './harness'
import { checkoutCompleted, stripeEvent } from './stripe-fake'

const HOUR = 3600
const PERIOD_START = Math.floor(Date.now() / 1000) - 5 * 24 * HOUR
const PERIOD_END = PERIOD_START + 30 * 24 * HOUR

async function subscribed(mode?: string, basePrice = 'price_team_month') {
  const h = await createHarness(mode ? { ENTITLEMENTS_MODE: mode } : {})
  const token = await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'owner', email: 'a@example.com' })
  const auth = { authorization: `Bearer ${token}` }
  await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team', seats: 2 }, headers: auth })
  const customer = [...h.stripe.customers.keys()][0]!
  const subscription = h.stripe.putSubscription({ customer, accountId: 'org:o1', basePrice, quantity: 2, periodStart: PERIOD_START, periodEnd: PERIOD_END })
  const delivered = await h.webhook(checkoutCompleted({ customer, subscription: subscription.id, accountId: 'org:o1' }))
  return { h, auth, customer, subscription, delivered }
}

function entitlement(h: Awaited<ReturnType<typeof createHarness>>, auth: Record<string, string>) {
  return h.call('GET', '/v1/billing/entitlements', { headers: auth }).then((response) => response.body)
}

/** Moves the monthly lookup key to a new price and points the env at it (a price change). */
async function changeMonthlyPrice(h: Awaited<ReturnType<typeof createHarness>>, id: string, product = 'prod_team') {
  h.stripe.prices.get('price_team_month')!.lookup_key = null
  h.stripe.prices.set(id, { id, active: true, currency: 'usd', unit_amount: 5500, unit_amount_decimal: '5500', lookup_key: 'orca_team_seat_monthly', product, recurring: { interval: 'month', usage_type: 'licensed' } })
  h.env.STRIPE_PRICE_TEAM_MONTHLY = id
  await syncCatalogPrices(h.env, createStripeClient(h.env, h.stripe.fetchImpl), Date.now())
}

describe('a price change never orphans existing subscribers (planForPrice)', () => {
  // Runs in every mode project: the fix doesn't depend on ENTITLEMENTS_MODE.
  it('a subscriber on the old price still has their cancel revoke access', async () => {
    const { h, auth, subscription } = await subscribed()
    expect((await entitlement(h, auth)).canStartSandbox).toBe(true)
    await changeMonthlyPrice(h, 'price_team_month_v2')
    subscription.status = 'canceled'
    expect((await h.webhook(stripeEvent('customer.subscription.deleted', subscription))).body).toEqual({ received: true })
    expect(await entitlement(h, auth)).toMatchObject({ status: 'canceled', canStartSandbox: false, reason: 'subscription_inactive' })
    const start = await h.controlPlane('/v1/internal/entitlements/check', { accountId: 'org:o1', machineSize: 'standard', runningSandboxes: 0 })
    expect(start.body).toMatchObject({ allow: false, reason: 'subscription_inactive' })
    if (h.env.ENTITLEMENTS_MODE === 'on' || h.env.ENTITLEMENTS_MODE === 'shadow') {
      const states = h.raw.prepare("SELECT DISTINCT state, revoked_reason FROM entitlement_grants WHERE source_type = 'subscription'").all()
      expect(states).toEqual([{ state: 'revoked', revoked_reason: 'stripe_canceled' }])
    }
  })

  it('recognizes a price it never saw that is on the plan\'s product', async () => {
    const h = await createHarness({ ENTITLEMENTS_MODE: 'on' })
    await changeMonthlyPrice(h, 'price_team_month_v2')
    // The key moves again, to a price created after our last sync.
    h.stripe.prices.set('price_team_month_v3', { id: 'price_team_month_v3', active: true, currency: 'usd', unit_amount: 5900, product: 'prod_team', recurring: { interval: 'month', usage_type: 'licensed' } })
    const token = await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'owner', email: 'a@example.com' })
    const auth = { authorization: `Bearer ${token}` }
    await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team', seats: 1 }, headers: auth })
    const customer = [...h.stripe.customers.keys()][0]!
    const subscription = h.stripe.putSubscription({ customer, accountId: 'org:o1', basePrice: 'price_team_month_v3', quantity: 1, periodStart: PERIOD_START, periodEnd: PERIOD_END })
    expect((await h.webhook(checkoutCompleted({ customer, subscription: subscription.id, accountId: 'org:o1' }))).body).toEqual({ received: true })
    expect(await entitlement(h, auth)).toMatchObject({ plan: 'team', interval: 'month', canStartSandbox: true, includedSeconds: 60 * HOUR })
    // ...and it is now in the price history.
    expect(h.raw.prepare("SELECT plan_id, role, interval FROM plan_prices WHERE stripe_price_id = 'price_team_month_v3'").get()).toEqual({ plan_id: 'team', role: 'seat', interval: 'month' })
  })

  it('maps a price by its metadata.orca_plan join key (no lookup key, unknown product)', async () => {
    const h = await createHarness({ ENTITLEMENTS_MODE: 'on' })
    h.stripe.prices.set('price_team_tagged', { id: 'price_team_tagged', active: true, currency: 'usd', unit_amount: 4000, product: 'prod_team_promo', metadata: { orca_plan: 'team' }, recurring: { interval: 'year', usage_type: 'licensed' } })
    const token = await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'owner', email: 'a@example.com' })
    const auth = { authorization: `Bearer ${token}` }
    await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team', seats: 1 }, headers: auth })
    const customer = [...h.stripe.customers.keys()][0]!
    const subscription = h.stripe.putSubscription({ customer, accountId: 'org:o1', basePrice: 'price_team_tagged', quantity: 1, periodStart: PERIOD_START, periodEnd: PERIOD_END })
    expect((await h.webhook(checkoutCompleted({ customer, subscription: subscription.id, accountId: 'org:o1' }))).body).toEqual({ received: true })
    expect(await entitlement(h, auth)).toMatchObject({ plan: 'team', interval: 'year', canStartSandbox: true })
  })

  it('still applies status for a known subscriber on an unmappable price', async () => {
    const { h, auth, subscription } = await subscribed('on')
    subscription.items.data[0]!.price = { id: 'price_mystery', recurring: { usage_type: 'licensed' } }
    subscription.status = 'canceled'
    expect((await h.webhook(stripeEvent('customer.subscription.deleted', subscription))).body).toEqual({ received: true })
    expect(await entitlement(h, auth)).toMatchObject({ plan: 'team', seats: 2, canStartSandbox: false, reason: 'subscription_inactive' })
  })

  it('still ignores an unknown subscription on an unknown price', async () => {
    const h = await createHarness({ ENTITLEMENTS_MODE: 'on' })
    const token = await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'owner', email: 'a@example.com' })
    await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team' }, headers: { authorization: `Bearer ${token}` } })
    const customer = [...h.stripe.customers.keys()][0]!
    const subscription = h.stripe.putSubscription({ customer, accountId: 'org:o1', basePrice: 'price_other_product', periodStart: PERIOD_START, periodEnd: PERIOD_END })
    expect((await h.webhook(checkoutCompleted({ customer, subscription: subscription.id, accountId: 'org:o1' }))).body).toEqual({
      ignored: 'unrecognized_subscription_items'
    })
  })
})

describe('Stripe states (ENTITLEMENTS_MODE=on)', () => {
  it('a live subscription whose period starts after our clock (a Stripe test clock) is granted now', async () => {
    const h = await createHarness({ ENTITLEMENTS_MODE: 'on' })
    const token = await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'owner', email: 'a@example.com' })
    const auth = { authorization: `Bearer ${token}` }
    await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team', seats: 1 }, headers: auth })
    const customer = [...h.stripe.customers.keys()][0]!
    const future = Math.floor(Date.now() / 1000) + 31 * 24 * HOUR
    const subscription = h.stripe.putSubscription({ customer, accountId: 'org:o1', basePrice: 'price_team_month', quantity: 1, periodStart: future, periodEnd: future + 30 * 24 * HOUR })
    await h.webhook(checkoutCompleted({ customer, subscription: subscription.id, accountId: 'org:o1' }))
    expect(await entitlement(h, auth)).toMatchObject({ status: 'active', canStartSandbox: true })
    // ...and agrees with the legacy computation (the shadow diff the dev test-clock run found).
    h.env.ENTITLEMENTS_MODE = 'shadow'
    await entitlement(h, auth)
    expect(h.raw.prepare('SELECT COUNT(*) AS n FROM entitlement_shadow_diffs').get()).toEqual({ n: 0 })
  })

  it('holds on pause and releases on resume', async () => {
    const { h, auth, subscription } = await subscribed('on')
    subscription.status = 'paused'
    await h.webhook(stripeEvent('customer.subscription.paused', subscription))
    expect(await entitlement(h, auth)).toMatchObject({ canStartSandbox: false, reason: 'subscription_inactive' })
    expect(h.raw.prepare("SELECT DISTINCT state, hold_reason FROM entitlement_grants").all()).toEqual([{ state: 'held', hold_reason: 'paused' }])
    subscription.status = 'active'
    await h.webhook(stripeEvent('customer.subscription.resumed', subscription))
    expect((await entitlement(h, auth)).canStartSandbox).toBe(true)
  })

  it('revokes everything when the Stripe customer is deleted', async () => {
    const { h, auth, customer } = await subscribed('on')
    expect((await h.webhook(stripeEvent('customer.deleted', { id: customer, object: 'customer' }))).body).toEqual({ received: true })
    expect(await entitlement(h, auth)).toMatchObject({ status: 'canceled', canStartSandbox: false })
    expect(h.raw.prepare('SELECT DISTINCT state FROM entitlement_grants').all()).toEqual([{ state: 'revoked' }])
  })

  it('never lets an older Stripe read overwrite the mirror', async () => {
    const { h, auth, subscription } = await subscribed('on')
    subscription.status = 'canceled'
    await syncSubscription(h.env, createStripeClient(h.env, h.stripe.fetchImpl), subscription.id, Date.now() + 1000)
    subscription.status = 'active'
    // A slower handler that read Stripe earlier finishes last.
    await syncSubscription(h.env, createStripeClient(h.env, h.stripe.fetchImpl), subscription.id, Date.now() - 1000)
    expect((await entitlement(h, auth)).status).toBe('canceled')
  })
})

describe('reconciliation (ENTITLEMENTS_MODE=on)', () => {
  it('replays events whose webhook never arrived', async () => {
    const h = await createHarness({ ENTITLEMENTS_MODE: 'on' })
    const stripe = createStripeClient(h.env, h.stripe.fetchImpl)
    const token = await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'owner', email: 'a@example.com' })
    const auth = { authorization: `Bearer ${token}` }
    await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team', seats: 1 }, headers: auth })
    // First run: only sets the cursor at the newest event.
    h.stripe.recordEvent({ id: 'evt_old', type: 'invoice.paid', created: 1, livemode: false, data: { object: { id: 'in_1', subscription: 'sub_gone' } } })
    expect((await reconcile(h.env, stripe, Date.now()))!.events).toEqual({ replayed: 0, applied: 0, failed: 0 })
    const customer = [...h.stripe.customers.keys()][0]!
    const subscription = h.stripe.putSubscription({ customer, accountId: 'org:o1', basePrice: 'price_team_month', quantity: 1, periodStart: PERIOD_START, periodEnd: PERIOD_END })
    const missed = checkoutCompleted({ customer, subscription: subscription.id, accountId: 'org:o1' })
    h.stripe.recordEvent({ id: missed.id, type: missed.type, created: missed.created, livemode: false, data: missed.data })
    expect((await entitlement(h, auth)).canStartSandbox).toBe(false)
    expect((await reconcile(h.env, stripe, Date.now()))!.events).toEqual({ replayed: 1, applied: 1, failed: 0 })
    expect((await entitlement(h, auth)).canStartSandbox).toBe(true)
    // A delivered-and-processed event is not applied twice.
    await h.webhook(missed)
    expect((await reconcile(h.env, stripe, Date.now()))!.events).toEqual({ replayed: 0, applied: 0, failed: 0 })
  })

  it('re-reads stale subscriptions: a cancel Stripe never told us about still revokes', async () => {
    const { h, auth, subscription } = await subscribed('on')
    const stripe = createStripeClient(h.env, h.stripe.fetchImpl)
    subscription.status = 'canceled'
    // Not stale yet: nothing re-read.
    expect((await reconcile(h.env, stripe, Date.now()))!.subscriptions).toMatchObject({ checked: 0 })
    const later = Date.now() + RESYNC_AFTER_MS + 1000
    h.setNow(later)
    expect((await reconcile(h.env, stripe, later))!.subscriptions).toEqual({ checked: 1, changed: 1, canceledMissing: 0, failed: 0 })
    expect(await entitlement(h, auth)).toMatchObject({ status: 'canceled', canStartSandbox: false })
    expect(h.raw.prepare('SELECT DISTINCT state FROM entitlement_grants').all()).toEqual([{ state: 'revoked' }])
    // Done: a canceled subscription with nothing live is not re-read again.
    expect((await reconcile(h.env, stripe, later + RESYNC_AFTER_MS * 2))!.subscriptions.checked).toBe(0)
  })

  it('cancels a subscription Stripe no longer has', async () => {
    const { h, auth, subscription } = await subscribed('on')
    h.stripe.subscriptions.delete(subscription.id)
    const later = Date.now() + RESYNC_AFTER_MS + 1000
    h.setNow(later)
    expect((await reconcile(h.env, createStripeClient(h.env, h.stripe.fetchImpl), later))!.subscriptions).toMatchObject({ canceledMissing: 1 })
    expect(await entitlement(h, auth)).toMatchObject({ status: 'canceled', canStartSandbox: false })
  })

  it('does nothing while the mode is off', async () => {
    const h = await createHarness({ ENTITLEMENTS_MODE: 'off' })
    expect(await reconcile(h.env, createStripeClient(h.env, h.stripe.fetchImpl), Date.now())).toBeNull()
  })
})

describe('EP-9: a portal cancel (cancel_at) on one of two teams of the same owner', () => {
  it('shows the cancelling team its own plan ending on cancel_at; the other team is untouched', async () => {
    const h = await createHarness()
    const as = async (org: string) => ({ authorization: `Bearer ${await h.desktopToken({ sub: 'owner', org, orgRole: 'owner', email: 'o@example.com' })}` })
    const eval3 = await as('eval')
    const paid1 = await as('paid')
    await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team', seats: 3 }, headers: eval3 })
    await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team', seats: 1 }, headers: paid1 })
    const [evalCustomer, paidCustomer] = [...h.stripe.customers.keys()]
    expect(evalCustomer).not.toBe(paidCustomer)
    const evalSub = h.stripe.putSubscription({ customer: evalCustomer!, accountId: 'org:eval', basePrice: 'price_team_month', quantity: 3, periodStart: PERIOD_START, periodEnd: PERIOD_END })
    const paidSub = h.stripe.putSubscription({ customer: paidCustomer!, accountId: 'org:paid', basePrice: 'price_team_month', quantity: 1, periodStart: PERIOD_START, periodEnd: PERIOD_END + 3 * 24 * HOUR })
    await h.webhook(checkoutCompleted({ customer: evalCustomer!, subscription: evalSub.id, accountId: 'org:eval' }))
    await h.webhook(checkoutCompleted({ customer: paidCustomer!, subscription: paidSub.id, accountId: 'org:paid' }))

    // The portal's cancel on API 2025-09-30.clover: cancel_at set, cancel_at_period_end stays false.
    const cancelAt = PERIOD_END + 3 * 24 * HOUR
    paidSub.cancel_at = cancelAt
    await h.webhook(stripeEvent('customer.subscription.updated', paidSub))

    const paid = await entitlement(h, paid1)
    expect(paid).toMatchObject({ plan: 'team', seats: 1, status: 'active', cancelAtPeriodEnd: true, cancelAt: cancelAt * 1000, canStartSandbox: true })
    expect(paid.includedSeconds).toBe(60 * HOUR)
    const other = await entitlement(h, eval3)
    expect(other).toMatchObject({ plan: 'team', seats: 3, cancelAtPeriodEnd: false, cancelAt: null })
    expect(other.includedSeconds).toBe(180 * HOUR)
    if (h.env.ENTITLEMENTS_MODE === 'on' || h.env.ENTITLEMENTS_MODE === 'shadow') {
      const ends = h.raw.prepare("SELECT DISTINCT subject_id, ends_at FROM entitlement_grants WHERE source_type = 'subscription' ORDER BY subject_id").all()
      expect(ends).toEqual([
        { subject_id: 'org:eval', ends_at: null },
        { subject_id: 'org:paid', ends_at: cancelAt * 1000 }
      ])
    }
    // Un-cancelling in the portal clears it.
    paidSub.cancel_at = null
    await h.webhook(stripeEvent('customer.subscription.updated', paidSub))
    expect(await entitlement(h, paid1)).toMatchObject({ cancelAtPeriodEnd: false, cancelAt: null })
  })
})

