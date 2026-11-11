// Opting out of overage: nothing more is metered or billed, and the metered item comes off the
// subscription once nothing on it is left to invoice (no $0 overage line on later invoices).
import { describe, expect, it } from 'vitest'
import { checkoutCompleted, stripeEvent } from './stripe-fake'
import { createHarness } from './harness'

const HOUR = 3600
const PERIOD_START = Math.floor(Date.now() / 1000) - 5 * 24 * HOUR
const PERIOD_END = PERIOD_START + 30 * 24 * HOUR

async function optedInTeam() {
  const h = await createHarness()
  const token = await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'owner', email: 'a@example.com' })
  const auth = { authorization: `Bearer ${token}` }
  await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team', seats: 2 }, headers: auth })
  const customer = [...h.stripe.customers.keys()][0]!
  const subscription = h.stripe.putSubscription({
    customer,
    accountId: 'org:o1',
    basePrice: 'price_team_month',
    quantity: 2,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END
  })
  await h.webhook(checkoutCompleted({ customer, subscription: subscription.id, accountId: 'org:o1' }))
  const overage = (body: unknown) => h.call('POST', '/v1/billing/overage', { body, headers: auth })
  expect((await overage({ enabled: true })).status).toBe(200)
  const prices = () => subscription.items.data.map((item) => item.price.id)
  expect(prices()).toEqual(['price_team_month', 'price_overage'])
  let n = 0
  const use = (hours: number) => {
    const endedAt = Date.now() - 60_000
    return h.controlPlane('/v1/internal/usage', {
      usageId: `u-${n++}`,
      accountId: 'org:o1',
      sandboxId: 'sbx_1',
      machineSize: 'standard',
      startedAt: endedAt - hours * HOUR * 1000,
      endedAt
    })
  }
  const stored = () =>
    h.raw.prepare('SELECT overage_enabled, overage_item_id IS NOT NULL AS has_item FROM subscriptions').get()
  return { h, auth, subscription, overage, prices, use, stored }
}

describe('overage opt-out', () => {
  it('removes the unused metered item at once, and opting back in adds it again', async () => {
    const { h, overage, prices, use, stored } = await optedInTeam()
    expect((await overage({ enabled: false })).status).toBe(200)
    expect(prices()).toEqual(['price_team_month'])
    expect(stored()).toEqual({ overage_enabled: 0, has_item: 0 })
    // Past the included hours with overage off: nothing is metered.
    for (let i = 0; i < 6; i++) {
      await use(24)
    }
    expect(h.stripe.meterEvents).toHaveLength(0)
    expect(h.raw.prepare('SELECT COUNT(*) AS n FROM meter_reports').get()).toEqual({ n: 0 })
    expect((await overage({ enabled: true })).status).toBe(200)
    expect(prices()).toEqual(['price_team_month', 'price_overage'])
  })

  it('a $0 cap never meters, even with overage on', async () => {
    const { h, overage, use } = await optedInTeam()
    expect((await overage({ enabled: true, spendCapCents: 0 })).status).toBe(200)
    for (let i = 0; i < 6; i++) {
      await use(24)
    }
    expect(h.stripe.meterEvents).toHaveLength(0)
    expect(h.raw.prepare('SELECT COUNT(*) AS n FROM meter_reports').get()).toEqual({ n: 0 })
  })

  it('keeps an item with usage to invoice until the period rolls over, then removes it', async () => {
    const { h, overage, prices, use, stored, subscription } = await optedInTeam()
    for (let i = 0; i < 5; i++) {
      await use(24)
    }
    await use(2)
    expect(h.stripe.meterEvents).toHaveLength(1)
    expect((await overage({ enabled: false })).status).toBe(200)
    // The 2 overage hours still have to be invoiced on this item.
    expect(prices()).toEqual(['price_team_month', 'price_overage'])
    await use(3)
    expect(h.stripe.meterEvents).toHaveLength(1)
    // A sync inside the same period keeps it.
    await h.webhook(stripeEvent('customer.subscription.updated', subscription))
    expect(prices()).toEqual(['price_team_month', 'price_overage'])
    // Renewal: the next period has nothing metered, so the sync takes the item off.
    for (const item of subscription.items.data) {
      item.current_period_start = PERIOD_END
      item.current_period_end = PERIOD_END + 30 * 24 * HOUR
    }
    await h.webhook(stripeEvent('customer.subscription.updated', subscription))
    expect(prices()).toEqual(['price_team_month'])
    expect(stored()).toEqual({ overage_enabled: 0, has_item: 0 })
  })
})
