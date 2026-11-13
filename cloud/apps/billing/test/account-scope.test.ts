// EP-9: every billing read is scoped by the verified token's org claim alone. Two teams of one
// owner, even sharing a Stripe customer, never see each other's plan, hours or usage.
import { describe, expect, it } from 'vitest'
import { createHarness } from './harness'

const HOUR = 3600
const NOW = Date.now()

function seed(h: Awaited<ReturnType<typeof createHarness>>, account: string, sub: string, seats: number, usedHours: number) {
  const start = NOW - 24 * HOUR * 1000
  h.raw.prepare('INSERT OR IGNORE INTO billing_accounts (account_id, stripe_customer_id, created_at, updated_at) VALUES (?, ?, ?, ?)').run(account, null, NOW, NOW)
  h.raw
    .prepare(
      `INSERT INTO subscriptions (stripe_subscription_id, account_id, stripe_customer_id, status, plan, seats, overage_enabled,
         current_period_start, current_period_end, cancel_at_period_end, updated_at, billing_interval)
       VALUES (?, ?, 'cus_shared', 'active', 'team', ?, 0, ?, ?, 0, ?, 'month')`
    )
    .run(sub, account, seats, start, start + 30 * 24 * HOUR * 1000, NOW)
  h.raw
    .prepare(
      `INSERT INTO usage_events (usage_id, account_id, sandbox_id, machine_size, started_at, ended_at, weighted_seconds, period_start, overage_seconds, created_at)
       VALUES (?, ?, 'sbx', 'standard', ?, ?, ?, ?, 0, ?)`
    )
    .run(`u_${sub}`, account, start, start + 1000, usedHours * HOUR, start, NOW)
}

describe('EP-9: billing reads follow the token, never the customer or another team', () => {
  it('two teams of one owner on one Stripe customer each read only their own plan and hours', async () => {
    const h = await createHarness()
    seed(h, 'org:eval', 'sub_eval', 3, 43)
    seed(h, 'org:paid', 'sub_paid', 1, 1)
    const read = async (org: string) =>
      (
        await h.call('GET', '/v1/billing/entitlements', {
          headers: { authorization: `Bearer ${await h.desktopToken({ sub: 'owner', org, orgRole: 'owner', email: 'o@example.com' })}` }
        })
      ).body
    const paid = await read('paid')
    const evalTeam = await read('eval')
    expect(paid).toMatchObject({ seats: 1, usedSeconds: 1 * HOUR, includedSeconds: 60 * HOUR })
    expect(evalTeam).toMatchObject({ seats: 3, usedSeconds: 43 * HOUR, includedSeconds: 180 * HOUR })
    // The control plane's start check is keyed by the account it names, the same way.
    const check = await h.controlPlane('/v1/internal/entitlements/check', { accountId: 'org:paid', machineSize: 'standard', runningSandboxes: 0 })
    expect(check.body.entitlement).toMatchObject({ seats: 1, usedSeconds: 1 * HOUR })
  })
})
