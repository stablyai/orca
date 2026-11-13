// AUDIT-AUTH-EVENTS (billing half): plan, seat, cancellation, overage and spend-cap changes
// reach the team's audit log on the sandbox control plane, with who acted when a person did.
import { describe, expect, it } from 'vitest'
import { hasTeamAuditLog, pushBillingAudit, subscriptionAuditEvents } from '../src/audit-push'
import { createHarness } from './harness'
import { checkoutCompleted, stripeEvent } from './stripe-fake'

const CONTROL = 'https://control.test'
const HOUR = 3600
const PERIOD_START = Math.floor(Date.now() / 1000) - 5 * 24 * HOUR
const PERIOD_END = PERIOD_START + 30 * 24 * HOUR

type Pushed = { accountId: string; eventId: string; action: string; at: number; actorUserId?: string; target: { type: string }; detail?: Record<string, unknown> }

/** The control plane over billing's service binding: every audit push, recorded. */
function controlPlane(options: { status?: number } = {}) {
  const requests: Array<{ url: string; authorization: string | null; body: { accountId: string; events: Array<Omit<Pushed, 'accountId'>> } }> = []
  const binding = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString()
      requests.push({ url, authorization: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) })
      return Response.json({ recorded: 1, duplicates: 0 }, { status: options.status ?? 200 })
    }
  }
  const events = (): Pushed[] => requests.flatMap((request) => request.body.events.map((event) => ({ ...event, accountId: request.body.accountId })))
  return { requests, binding, events }
}

async function team(options: { status?: number } = {}) {
  const control = controlPlane(options)
  const h = await createHarness({ SANDBOX_CONTROL_URL: CONTROL })
  // SAFETY: the Worker only calls fetch on the binding.
  h.env.SANDBOX_CONTROL = control.binding as unknown as Fetcher
  const token = await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'owner', email: 'a@example.com' })
  const auth = { authorization: `Bearer ${token}` }
  const accountId = 'org:o1'
  await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team', seats: 2 }, headers: auth })
  const customer = [...h.stripe.customers.keys()][0]!
  const subscription = h.stripe.putSubscription({ customer, accountId, basePrice: 'price_team_month', quantity: 2, periodStart: PERIOD_START, periodEnd: PERIOD_END })
  await h.webhook(checkoutCompleted({ customer, subscription: subscription.id, accountId }))
  return { h, auth, control, subscription, accountId }
}

describe('subscription changes', () => {
  it('records the plan starting, seats changing, a cancellation scheduled and reverted, and the plan ending', async () => {
    const { h, control, subscription } = await team()
    expect(control.events()).toEqual([
      {
        accountId: 'org:o1',
        eventId: expect.stringMatching(/^billing_[0-9a-f]{40}$/),
        action: 'billing.plan_started',
        at: expect.any(Number),
        target: { type: 'plan' },
        detail: { plan: 'team', interval: 'month', seats: 2 }
      }
    ])
    // Billing's own bearer, to the one route it may write.
    expect(control.requests[0]).toMatchObject({ url: `${CONTROL}/v1/internal/audit-events`, authorization: `Bearer ${h.env.CONTROL_PLANE_TOKEN.split(',')[0]}` })

    subscription.items.data[0]!.quantity = 5
    await h.webhook(stripeEvent('customer.subscription.updated', subscription))
    subscription.cancel_at_period_end = true
    await h.webhook(stripeEvent('customer.subscription.updated', subscription))
    subscription.cancel_at_period_end = false
    await h.webhook(stripeEvent('customer.subscription.updated', subscription))
    subscription.status = 'canceled'
    await h.webhook(stripeEvent('customer.subscription.deleted', subscription))
    expect(control.events().map((event) => [event.action, event.detail ?? null])).toEqual([
      ['billing.plan_started', { plan: 'team', interval: 'month', seats: 2 }],
      ['billing.seats_changed', { seats: 5, previousSeats: 2 }],
      ['billing.cancel_scheduled', null],
      ['billing.cancel_reverted', null],
      ['billing.plan_canceled', { plan: 'team' }]
    ])
    // Stripe reported these: no person is named.
    expect(control.events().every((event) => event.actorUserId === undefined)).toBe(true)
  })

  it('a replayed or unchanged Stripe event records nothing more', async () => {
    const { h, control, subscription } = await team()
    await h.webhook(stripeEvent('customer.subscription.updated', subscription))
    await h.webhook(stripeEvent('customer.subscription.updated', subscription))
    await h.webhook(stripeEvent('invoice.paid', { id: 'in_1', customer: subscription.customer, subscription: subscription.id }))
    expect(control.events().map((event) => event.action)).toEqual(['billing.plan_started'])
  })

  it('works out what changed from the stored row alone', () => {
    const live = { status: 'active', plan: 'team', billing_interval: 'month', seats: 2, cancel_at_period_end: 0 } as const
    const actions = (before: Parameters<typeof subscriptionAuditEvents>[0], after: Parameters<typeof subscriptionAuditEvents>[1]) =>
      subscriptionAuditEvents(before, after, 1).map((event) => event.action)
    expect(actions(null, live)).toEqual(['billing.plan_started'])
    // Checkout made it but the first payment has not gone through: not a plan yet.
    expect(actions(null, { ...live, status: 'incomplete' })).toEqual([])
    expect(actions({ ...live, status: 'incomplete' }, live)).toEqual(['billing.plan_started'])
    expect(actions({ ...live, status: 'incomplete' }, { ...live, status: 'incomplete_expired' })).toEqual([])
    // A failed payment is not a plan change; it keeps its own notices.
    expect(actions(live, { ...live, status: 'past_due' })).toEqual([])
    expect(actions(live, { ...live, billing_interval: 'year', seats: 3 })).toEqual(['billing.plan_changed', 'billing.seats_changed'])
    expect(subscriptionAuditEvents(live, { ...live, billing_interval: 'year' }, 1)[0]!.detail).toEqual({ plan: 'team', interval: 'year', previousPlan: 'team', previousInterval: 'month' })
    expect(actions(live, { ...live, status: 'canceled' })).toEqual(['billing.plan_canceled'])
    expect(actions({ ...live, status: 'canceled' }, { ...live, status: 'canceled' })).toEqual([])
    // A team that comes back after canceling starts a plan again.
    expect(actions({ ...live, status: 'canceled' }, live)).toEqual(['billing.plan_started'])
  })
})

describe('overage and the spend cap', () => {
  it('records who turned overage on or off and who changed the cap, and only real changes', async () => {
    const { h, auth, control } = await team()
    const overage = (body: unknown) => h.call('POST', '/v1/billing/overage', { body, headers: auth })
    const mine = () => control.events().filter((event) => event.action !== 'billing.plan_started' && event.action !== 'billing.seats_changed')
    expect((await overage({ enabled: true, spendCapCents: 4000 })).status).toBe(200)
    expect(mine().map((event) => [event.action, event.actorUserId, event.detail ?? null])).toEqual([
      ['billing.overage_enabled', 'u1', null],
      ['billing.spend_cap_changed', 'u1', { spendCapCents: 4000, previousSpendCapCents: null }]
    ])
    // The same settings again: nothing changed, nothing recorded.
    expect((await overage({ enabled: true, spendCapCents: 4000 })).status).toBe(200)
    expect((await overage({ enabled: true })).status).toBe(200)
    expect(mine()).toHaveLength(2)
    expect((await overage({ enabled: true, spendCapCents: 9000 })).status).toBe(200)
    expect((await overage({ enabled: false })).status).toBe(200)
    expect(mine().slice(2).map((event) => [event.action, event.detail ?? null])).toEqual([
      ['billing.spend_cap_changed', { spendCapCents: 9000, previousSpendCapCents: 4000 }],
      ['billing.overage_disabled', null]
    ])
  })

  it('records nothing for a change that was refused', async () => {
    const { h, control } = await team()
    const member = await h.desktopToken({ sub: 'u2', org: 'o1', orgRole: 'member', email: 'b@example.com' })
    const refused = await h.call('POST', '/v1/billing/overage', { body: { enabled: true }, headers: { authorization: `Bearer ${member}` } })
    expect(refused.status).toBe(403)
    expect(control.events().filter((event) => event.action.startsWith('billing.overage'))).toEqual([])
  })
})

describe('the push itself', () => {
  it('a control plane that refuses or is down never fails the billing change', async () => {
    const { h, auth, control } = await team({ status: 500 })
    const changed = await h.call('POST', '/v1/billing/overage', { body: { enabled: true }, headers: auth })
    expect(changed.status).toBe(200)
    expect(changed.body.overage.optedIn).toBe(true)
    expect(control.requests.length).toBeGreaterThan(0)
  })

  it('a personal account has no team log: nothing is sent', async () => {
    const control = controlPlane()
    // SAFETY: the push only calls fetch on the binding.
    const env = { CONTROL_PLANE_TOKEN: 'c'.repeat(40), SANDBOX_CONTROL_URL: CONTROL, SANDBOX_CONTROL: control.binding as unknown as Fetcher }
    expect(await pushBillingAudit(env, 'user:u1', [{ action: 'billing.plan_started', at: 1 }])).toBe(false)
    expect(control.requests).toEqual([])
    expect(await pushBillingAudit(env, 'org:o1', [{ action: 'billing.plan_started', at: 1 }])).toBe(true)
    expect(control.requests).toHaveLength(1)
    expect([hasTeamAuditLog('org:o1'), hasTeamAuditLog('dev:org:x'), hasTeamAuditLog('user:u1'), hasTeamAuditLog('dev:alice')]).toEqual([true, true, false, false])
  })

  it('sends nothing when the control plane is not configured, and never a price, customer or card', async () => {
    expect(await pushBillingAudit({ CONTROL_PLANE_TOKEN: 'c'.repeat(40) }, 'org:o1', [{ action: 'billing.plan_started', at: 1 }])).toBe(false)
    const { h, auth, control, subscription } = await team()
    await h.call('POST', '/v1/billing/overage', { body: { enabled: true, spendCapCents: 5000 }, headers: auth })
    const sent = JSON.stringify(control.requests.map((request) => request.body))
    expect(sent).not.toMatch(/price_|cus_|sub_test|si_test|card/)
    expect(sent).not.toContain(subscription.id)
    // Keys the control plane refuses as credential-like are never used.
    for (const event of control.events()) {
      for (const key of Object.keys(event.detail ?? {})) {
        expect(key).not.toMatch(/secret|token|password|passphrase|hint|value|ciphertext|credential|private|code/i)
      }
    }
  })
})
