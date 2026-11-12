import { describe, expect, it } from 'vitest'
import { checkoutCompleted } from './stripe-fake'
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
    expect(await read(h, 'org:never')).toEqual({ status: 200, body: { status: null, open: false } })

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
    expect((await read(h, 'org:o1')).body).toEqual({ status: 'active', open: true })

    for (const [status, open] of [
      ['past_due', true],
      ['unpaid', true],
      ['canceled', false]
    ] as const) {
      h.raw.prepare('UPDATE subscriptions SET status = ? WHERE account_id = ?').run(status, 'org:o1')
      expect((await read(h, 'org:o1')).body).toEqual({ status, open })
    }
  })

  it('answers only auth’s membership token, and only for teams', async () => {
    const h = await createHarness({ MEMBERSHIP_SYNC_TOKEN: MEMBERSHIP_TOKEN })
    expect((await read(h, 'org:o1', CONTROL_TOKEN)).status).toBe(401)
    expect((await read(h, 'org:o1', 'nope')).status).toBe(401)
    expect((await read(h, 'user:u1')).status).toBe(404)
  })
})
