import { describe, expect, it } from 'vitest'
import { checkoutCompleted, invoiceEvent, stripeEvent } from './stripe-fake'
import { createHarness, CONTROL_TOKEN } from './harness'

const HOUR = 3600
const PERIOD_START = Math.floor(Date.now() / 1000) - 5 * 24 * HOUR
const PERIOD_END = PERIOD_START + 30 * 24 * HOUR
const MEMBERSHIP_TOKEN = 'ms_test_0123456789abcdef0123456789abcdef'

async function team(seats = 2) {
  const h = await createHarness({ MEMBERSHIP_SYNC_TOKEN: MEMBERSHIP_TOKEN })
  const owner = await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'owner' })
  await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team', seats }, headers: { authorization: `Bearer ${owner}` } })
  const customer = [...h.stripe.customers.keys()][0]!
  const subscription = h.stripe.putSubscription({
    customer,
    accountId: 'org:o1',
    basePrice: 'price_team_month',
    quantity: seats,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END
  })
  await h.webhook(checkoutCompleted({ customer, subscription: subscription.id, accountId: 'org:o1' }))
  return { h, customer, subscription }
}

const seatUpdates = (h: Awaited<ReturnType<typeof team>>['h']) =>
  h.stripe.calls
    .filter((call) => call.method === 'POST' && call.path.startsWith('/v1/subscription_items/'))
    .map((call) => ({ quantity: call.form.get('quantity'), proration: call.form.get('proration_behavior') }))

describe('seats follow membership', () => {
  it('auth pushes member counts: adds invoice now, removals credit next invoice, min 1 seat', async () => {
    const { h } = await team(2)
    const push = (members: number, token = MEMBERSHIP_TOKEN) =>
      h.call('POST', '/v1/internal/seats', { body: { accountId: 'org:o1', members }, headers: { authorization: `Bearer ${token}` } })

    expect((await push(3, CONTROL_TOKEN)).status).toBe(401)
    expect((await push(3)).body).toEqual({ status: 'updated', seats: 3, previous: 2 })
    expect((await push(3)).body).toEqual({ status: 'unchanged', seats: 3 })
    expect((await push(1)).body).toEqual({ status: 'updated', seats: 1, previous: 3 })
    expect((await push(0)).body).toEqual({ status: 'unchanged', seats: 1 })
    expect(seatUpdates(h)).toEqual([
      { quantity: '3', proration: 'always_invoice' },
      { quantity: '1', proration: 'create_prorations' }
    ])
    const owner = await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'owner' })
    const entitlement = await h.call('GET', '/v1/billing/entitlements', { headers: { authorization: `Bearer ${owner}` } })
    expect(entitlement.body).toMatchObject({ seats: 1, includedSeconds: 60 * HOUR, limits: { maxConcurrentSandboxes: 3 } })
  })

  it('Checkout bills the live member count from auth, never fewer than 1 seat', async () => {
    const h = await createHarness()
    const owner = await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'owner' })
    const seen: string[] = []
    h.setMembership(async (orgId) => {
      seen.push(orgId)
      return 0
    })
    await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team', seats: 9 }, headers: { authorization: `Bearer ${owner}` } })
    expect(seen).toEqual(['o1'])
    expect(h.stripe.calls.find((call) => call.path === '/v1/checkout/sessions')?.form.get('line_items[0][quantity]')).toBe('1')
  })

  it('fails closed when auth is configured but cannot answer', async () => {
    const h = await createHarness()
    const owner = await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'owner' })
    const { MembershipUnavailableError } = await import('../src/membership')
    h.setMembership(async () => {
      throw new MembershipUnavailableError('auth answered 500')
    })
    expect(await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team' }, headers: { authorization: `Bearer ${owner}` } })).toEqual({
      status: 503,
      body: { error: 'membership_unavailable' }
    })
    expect(h.stripe.calls).toHaveLength(0)
  })

  it('the reconcile cron heals a missed membership push', async () => {
    const { h } = await team(2)
    const { reconcileSeats } = await import('../src/seats')
    const { createStripeClient } = await import('../src/stripe')
    const stripe = createStripeClient(h.env, h.stripe.fetchImpl)
    expect(await reconcileSeats(h.env, stripe, async () => 5, Date.now())).toEqual({ checked: 1, updated: 1, failed: 0 })
    expect(await reconcileSeats(h.env, stripe, async () => 5, Date.now())).toEqual({ checked: 1, updated: 0, failed: 0 })
    expect(seatUpdates(h)).toEqual([{ quantity: '5', proration: 'always_invoice' }])
  })

  it('billing admin actions need a freshly minted token (role re-read by auth at mint)', async () => {
    const { h } = await team(2)
    const stale = await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'owner' }, { ageSeconds: 7 * 60 })
    const auth = { authorization: `Bearer ${stale}` }
    expect((await h.call('GET', '/v1/billing/entitlements', { headers: auth })).status).toBe(200)
    expect((await h.call('POST', '/v1/billing/portal', { headers: auth })).status).toBe(401)
    expect((await h.call('POST', '/v1/billing/overage', { body: { enabled: true }, headers: auth })).status).toBe(401)
    expect((await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team' }, headers: auth })).status).toBe(401)
  })

  it('rejects malformed or missing member counts instead of billing 0 seats', async () => {
    const { h } = await team(2)
    for (const body of [{ accountId: 'org:o1' }, { accountId: 'org:o1', members: -1 }, { accountId: 'org:o1', members: 'many' }, { accountId: 'user:u1', members: 3 }]) {
      const response = await h.call('POST', '/v1/internal/seats', { body, headers: { authorization: `Bearer ${MEMBERSHIP_TOKEN}` } })
      expect(response.status).toBe(400)
    }
    expect(seatUpdates(h)).toEqual([])
  })

  it('does nothing without an open subscription', async () => {
    const h = await createHarness({ MEMBERSHIP_SYNC_TOKEN: MEMBERSHIP_TOKEN })
    const pushed = await h.call('POST', '/v1/internal/seats', {
      body: { accountId: 'org:nobody', members: 5 },
      headers: { authorization: `Bearer ${MEMBERSHIP_TOKEN}` }
    })
    expect(pushed.body).toEqual({ status: 'no_subscription' })
    expect(h.stripe.calls.filter((call) => call.method === 'POST')).toHaveLength(0)
  })
})

describe('payment failure grace', () => {
  it('blocks new starts at once, suspends running after 4 days, resumes when paid', async () => {
    const { h, customer, subscription } = await team(2)
    const failedAt = Date.now()
    h.setNow(failedAt)
    subscription.status = 'past_due'
    await h.webhook(invoiceEvent('invoice.payment_failed', subscription.id, customer))
    const check = () =>
      h.controlPlane('/v1/internal/entitlements/check', { accountId: 'org:o1', machineSize: 'standard', runningSandboxes: 0 })
    const suspensions = () => h.call('GET', '/v1/internal/suspensions', { headers: { authorization: `Bearer ${CONTROL_TOKEN}` } })

    expect((await check()).body).toMatchObject({ allow: false, reason: 'payment_past_due', suspendRunning: false })
    expect((await check()).body.entitlement.payment).toEqual({
      pastDueSince: failedAt,
      graceEndsAt: failedAt + 96 * HOUR * 1000,
      suspendRunning: false
    })
    expect((await suspensions()).body).toEqual({ accounts: [] })

    // A retry failing again later must not restart the grace clock.
    h.setNow(failedAt + 50 * HOUR * 1000)
    await h.webhook(invoiceEvent('invoice.payment_failed', subscription.id, customer))
    h.setNow(failedAt + 97 * HOUR * 1000)
    expect((await check()).body).toMatchObject({ allow: false, reason: 'payment_grace_expired', suspendRunning: true })
    expect((await suspensions()).body.accounts).toEqual([
      { accountId: 'org:o1', pastDueSince: failedAt, graceEndsAt: failedAt + 96 * HOUR * 1000 }
    ])
    const usage = await h.controlPlane('/v1/internal/usage', {
      usageId: 'u-1',
      accountId: 'org:o1',
      sandboxId: 's',
      machineSize: 'standard',
      startedAt: failedAt + 96 * HOUR * 1000 - 60_000,
      endedAt: failedAt + 96 * HOUR * 1000
    })
    expect(usage.body).toMatchObject({ canStartSandbox: false, suspendRunning: true })

    // Retries exhausted (unpaid) stays suspended; paying restores everything.
    subscription.status = 'unpaid'
    await h.webhook(stripeEvent('customer.subscription.updated', subscription))
    expect((await check()).body).toMatchObject({ reason: 'payment_grace_expired' })
    subscription.status = 'active'
    await h.webhook(invoiceEvent('invoice.paid', subscription.id, customer))
    expect((await check()).body).toMatchObject({ allow: true, suspendRunning: false })
    expect((await suspensions()).body).toEqual({ accounts: [] })
  })

  it('takes the grace length from config', async () => {
    const h = await createHarness({ BILLING_PLANS: JSON.stringify({ team: { paymentGraceHours: 0 } }) })
    const owner = await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'owner' })
    await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team' }, headers: { authorization: `Bearer ${owner}` } })
    const customer = [...h.stripe.customers.keys()][0]!
    const subscription = h.stripe.putSubscription({
      customer,
      accountId: 'org:o1',
      basePrice: 'price_team_month',
      status: 'past_due',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END
    })
    await h.webhook(stripeEvent('customer.subscription.updated', subscription))
    const entitlement = await h.call('GET', '/v1/billing/entitlements', { headers: { authorization: `Bearer ${owner}` } })
    expect(entitlement.body).toMatchObject({ reason: 'payment_grace_expired', payment: { suspendRunning: true } })
  })
})
