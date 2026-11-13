import { describe, expect, it } from 'vitest'
import { checkoutCompleted, stripeEvent } from './stripe-fake'
import { createHarness, CONTROL_TOKEN } from './harness'

// TEAM-DELETE: auth asks whether a team still has an open subscription before deleting it.
const MEMBERSHIP_TOKEN = 'ms_test_0123456789abcdef0123456789abcdef'
const PERIOD_START = Math.floor(Date.now() / 1000) - 5 * 24 * 3600

describe('GET /v1/internal/accounts/:accountId/subscription', () => {
  const read = (h: Awaited<ReturnType<typeof createHarness>>, accountId: string, token = MEMBERSHIP_TOKEN) =>
    h.call('GET', `/v1/internal/accounts/${accountId}/subscription`, {
      headers: { authorization: `Bearer ${token}` }
    })

  it('reports an open subscription, and none for a team that never had one', async () => {
    const h = await createHarness({ MEMBERSHIP_SYNC_TOKEN: MEMBERSHIP_TOKEN })
    expect(await read(h, 'org:never')).toEqual({ status: 200, body: { status: null, open: false, cancelling: false, endsAt: null, periodEnd: null } })

    const owner = await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'owner' })
    await h.call('POST', '/v1/billing/checkout', {
      body: { plan: 'team', seats: 2 },
      headers: { authorization: `Bearer ${owner}` }
    })
    const customer = [...h.stripe.customers.keys()][0]!
    const subscription = h.stripe.putSubscription({
      customer,
      accountId: 'org:o1',
      basePrice: 'price_team_month',
      quantity: 2,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_START + 30 * 24 * 3600
    })
    await h.webhook(checkoutCompleted({ customer, subscription: subscription.id, accountId: 'org:o1' }))
    expect((await read(h, 'org:o1')).body).toMatchObject({ status: 'active', open: true, cancelling: false, endsAt: null })

    for (const [status, open] of [
      ['past_due', true],
      ['unpaid', true],
      ['canceled', false]
    ] as const) {
      h.raw.prepare('UPDATE subscriptions SET status = ? WHERE account_id = ?').run(status, 'org:o1')
      expect((await read(h, 'org:o1')).body).toMatchObject({ status, open })
    }
  })

  it('answers only auth’s membership token, and only for teams', async () => {
    const h = await createHarness({ MEMBERSHIP_SYNC_TOKEN: MEMBERSHIP_TOKEN })
    expect((await read(h, 'org:o1', CONTROL_TOKEN)).status).toBe(401)
    expect((await read(h, 'org:o1', 'nope')).status).toBe(401)
    expect((await read(h, 'user:u1')).status).toBe(404)
  })
})

describe('EP-10: deleting a team whose plan is already set to end', () => {
  async function team(h: Awaited<ReturnType<typeof createHarness>>) {
    const owner = await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'owner' })
    await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team', seats: 1 }, headers: { authorization: `Bearer ${owner}` } })
    const customer = [...h.stripe.customers.keys()][0]!
    const subscription = h.stripe.putSubscription({
      customer,
      accountId: 'org:o1',
      basePrice: 'price_team_month',
      quantity: 1,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_START + 30 * 24 * 3600
    })
    await h.webhook(checkoutCompleted({ customer, subscription: subscription.id, accountId: 'org:o1' }))
    return { subscription, auth: { authorization: `Bearer ${owner}` } }
  }
  const cancelNow = (h: Awaited<ReturnType<typeof createHarness>>, token = MEMBERSHIP_TOKEN) =>
    h.call('POST', '/v1/internal/accounts/org:o1/subscription/cancel-now', { headers: { authorization: `Bearer ${token}` } })

  it('never cancels a renewing plan from here', async () => {
    const h = await createHarness({ MEMBERSHIP_SYNC_TOKEN: MEMBERSHIP_TOKEN })
    const { subscription } = await team(h)
    expect(await cancelNow(h)).toEqual({ status: 409, body: { error: 'not_cancelling' } })
    expect(h.stripe.subscriptions.get(subscription.id)!.status).toBe('active')
    expect((await cancelNow(h, CONTROL_TOKEN)).status).toBe(401)
  })

  it('reports a portal cancel as cancelling with its end date, then cancels it now and revokes access', async () => {
    const h = await createHarness({ MEMBERSHIP_SYNC_TOKEN: MEMBERSHIP_TOKEN })
    const { subscription, auth } = await team(h)
    const endsAt = PERIOD_START + 30 * 24 * 3600
    subscription.cancel_at = endsAt
    await h.webhook(stripeEvent('customer.subscription.updated', subscription))
    const view = await h.call('GET', '/v1/internal/accounts/org:o1/subscription', { headers: { authorization: `Bearer ${MEMBERSHIP_TOKEN}` } })
    expect(view.body).toEqual({ status: 'active', open: true, cancelling: true, endsAt: endsAt * 1000, periodEnd: endsAt * 1000 })

    expect(await cancelNow(h)).toEqual({ status: 200, body: { canceled: true } })
    // Usage already reported is invoiced; the rest of the period isn't refunded.
    expect(h.stripe.cancelParams).toEqual([{ invoice_now: 'true', prorate: 'false' }])
    expect(h.stripe.subscriptions.get(subscription.id)!.status).toBe('canceled')
    expect((await h.call('GET', '/v1/billing/entitlements', { headers: auth })).body).toMatchObject({ status: 'canceled', canStartSandbox: false })
    // Idempotent.
    expect(await cancelNow(h)).toEqual({ status: 200, body: { canceled: true } })
  })

  it('refuses (409) a plan resumed after the delete check, even before its webhook lands', async () => {
    const h = await createHarness({ MEMBERSHIP_SYNC_TOKEN: MEMBERSHIP_TOKEN })
    const { subscription } = await team(h)
    subscription.cancel_at_period_end = true
    await h.webhook(stripeEvent('customer.subscription.updated', subscription))
    const view = await h.call('GET', '/v1/internal/accounts/org:o1/subscription', { headers: { authorization: `Bearer ${MEMBERSHIP_TOKEN}` } })
    expect(view.body.cancelling).toBe(true)
    // The owner resumes in the portal; no webhook delivered yet.
    subscription.cancel_at_period_end = false
    expect(await cancelNow(h)).toEqual({ status: 409, body: { error: 'not_cancelling' } })
    expect(h.stripe.cancelParams).toEqual([])
    expect(h.stripe.subscriptions.get(subscription.id)!.status).toBe('active')
  })

  it('refuses (502) and changes nothing when Stripe fails', async () => {
    const h = await createHarness({ MEMBERSHIP_SYNC_TOKEN: MEMBERSHIP_TOKEN })
    const { subscription } = await team(h)
    subscription.cancel_at_period_end = true
    await h.webhook(stripeEvent('customer.subscription.updated', subscription))
    h.stripe.failNextSubscriptionCancels(1)
    expect(await cancelNow(h)).toEqual({ status: 502, body: { error: 'stripe_unavailable' } })
    expect(h.stripe.subscriptions.get(subscription.id)!.status).toBe('active')
  })
})

