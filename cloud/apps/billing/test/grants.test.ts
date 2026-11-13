// Plans & entitlements: the D1 catalog, grant projection from Stripe and trial state, the
// resolver (ENTITLEMENTS_MODE=on), manual grants, backfill, and the shadow comparison.
import { describe, expect, it } from 'vitest'
import { applyCatalog, catalogStatements, loadCatalog, parseCatalogFile } from '../src/catalog'
import { aggregateGrants } from '../src/entitlement-keys'
import { computeEntitlement, diffEntitlements } from '../src/entitlements'
import { backfillGrants } from '../src/entitlements-backfill'
import { applyProjection, grantsForSource, putManualGrant, revokeManualGrant, subscriptionProjection } from '../src/grants'
import { repoCatalog } from './catalog-fixture'
import { createHarness } from './harness'
import { checkoutCompleted, invoiceEvent, stripeEvent } from './stripe-fake'

const HOUR = 3600
const PERIOD_START = Math.floor(Date.now() / 1000) - 5 * 24 * HOUR
const PERIOD_END = PERIOD_START + 30 * 24 * HOUR

async function team(options: { mode?: string; seats?: number } = {}) {
  const h = await createHarness({ ENTITLEMENTS_MODE: options.mode ?? 'on' })
  const token = await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'owner', email: 'a@example.com' })
  const auth = { authorization: `Bearer ${token}` }
  await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team', seats: options.seats ?? 2 }, headers: auth })
  const customer = [...h.stripe.customers.keys()][0]!
  return { h, auth, customer }
}

async function subscribe(h: Awaited<ReturnType<typeof team>>['h'], customer: string, seats = 2) {
  const subscription = h.stripe.putSubscription({
    customer,
    accountId: 'org:o1',
    basePrice: 'price_team_month',
    quantity: seats,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END
  })
  expect((await h.webhook(checkoutCompleted({ customer, subscription: subscription.id, accountId: 'org:o1' }))).body).toEqual({ received: true })
  return subscription
}

function grantRows(h: Awaited<ReturnType<typeof team>>['h'], source = 'subscription') {
  return h.raw
    .prepare('SELECT entitlement_key, value_json, per_seat, seat_quantity, state, hold_reason, ends_at, revoked_reason, plan_version FROM entitlement_grants WHERE source_type = ? ORDER BY entitlement_key')
    .all(source) as Array<Record<string, unknown>>
}

describe('catalog', () => {
  it('parses the repo catalog: Team, Enterprise and the trial, with no prices in it', () => {
    const file = parseCatalogFile(repoCatalog())
    expect(file.plans.map((plan) => [plan.id, plan.kind])).toEqual([
      ['team', 'self_serve'],
      ['enterprise', 'contact_sales'],
      ['trial', 'trial']
    ])
    expect(JSON.stringify(file)).not.toMatch(/price_|unit_amount|\$\d/)
  })

  it('re-applying the same file is a no-op; an applied version can never be rewritten', async () => {
    const h = await createHarness()
    expect(await applyCatalog(h.env.BILLING_DB, repoCatalog(), Date.now())).toBe(0)
    const changed = repoCatalog()
    changed.plans[0]!.versions[0]!.entitlements.sandbox_hours_monthly = { value: 80, perSeat: true }
    await expect(applyCatalog(h.env.BILLING_DB, changed, Date.now())).rejects.toThrow(/already applied with different content/)
    // A new version is how a plan changes.
    const original = repoCatalog().plans[0]!.versions
    changed.plans[0]!.versions = [...original, { ...changed.plans[0]!.versions[0]!, version: 3 }]
    changed.plans[0]!.currentVersion = 3
    expect(await applyCatalog(h.env.BILLING_DB, changed, Date.now())).toBe(2)
    expect((await loadCatalog(h.env.BILLING_DB)).plans.get('team')!.currentVersion).toBe(3)
  })

  it('rejects unknown keys, bad values, per-seat on a flat key, and a self-serve plan without a policy', () => {
    const withEntitlement = (key: string, entry: unknown) => {
      const file = repoCatalog()
      ;(file.plans[0]!.versions[0]!.entitlements as Record<string, unknown>)[key] = entry
      return file
    }
    expect(() => parseCatalogFile(withEntitlement('gpu_hours', { value: 1 }))).toThrow(/unknown entitlement key/)
    expect(() => parseCatalogFile(withEntitlement('sandbox_hours_monthly', { value: 'lots' }))).toThrow(/invalid value/)
    expect(() => parseCatalogFile(withEntitlement('max_concurrent_sandboxes_per_member', { value: 5, perSeat: true }))).toThrow(/cannot be per seat/)
    expect(() => parseCatalogFile(withEntitlement('machine_sizes', { value: ['huge'] }))).toThrow(/invalid value/)
    const noPolicy = repoCatalog()
    noPolicy.plans[0]!.versions[0]!.policy = {}
    expect(() => parseCatalogFile(noPolicy)).toThrow(/needs a full policy/)
  })

  it('takes an https: or mailto: supportUrl on a plan, nothing else', () => {
    const withSupport = (url: string) => {
      const file = repoCatalog()
      ;(file.plans[0] as { supportUrl?: string }).supportUrl = url
      return file
    }
    expect(() => parseCatalogFile(withSupport('https://orca.dev/support'))).not.toThrow()
    expect(() => parseCatalogFile(withSupport('mailto:support@orca.dev'))).not.toThrow()
    for (const bad of ['javascript:alert(1)', 'http://orca.dev/support', 'mailto:nobody']) {
      expect(() => parseCatalogFile(withSupport(bad))).toThrow()
    }
  })

  it('generates parameterized SQL only (the apply script inlines nothing it did not validate)', async () => {
    const statements = await catalogStatements(parseCatalogFile(repoCatalog()), [], 1)
    // 3 plan rows + every version (Team has 2).
    expect(statements.length).toBe(3 + parseCatalogFile(repoCatalog()).plans.reduce((n, plan) => n + plan.versions.length, 0))
    for (const statement of statements) {
      expect(statement.sql).not.toContain("'team'")
    }
  })
})

describe('aggregation', () => {
  it('sums per-seat hours and concurrency, takes the max per member, unions sizes, ORs overage', () => {
    expect(
      aggregateGrants([
        { key: 'sandbox_hours_monthly', value: 60, perSeat: true, seats: 3 },
        { key: 'sandbox_hours_monthly', value: 10, perSeat: false, seats: null },
        { key: 'max_concurrent_sandboxes', value: 3, perSeat: true, seats: 0 },
        { key: 'max_concurrent_sandboxes_per_member', value: 3, perSeat: false, seats: null },
        { key: 'max_concurrent_sandboxes_per_member', value: 5, perSeat: false, seats: null },
        { key: 'machine_sizes', value: ['large'], perSeat: false, seats: null },
        { key: 'machine_sizes', value: ['standard'], perSeat: false, seats: null },
        { key: 'overage_allowed', value: false, perSeat: false, seats: null },
        { key: 'overage_allowed', value: true, perSeat: false, seats: null }
      ])
    ).toEqual({
      sandboxSecondsMonthly: 190 * HOUR,
      sandboxSecondsLifetime: 0,
      // 0 seats still counts as one.
      maxConcurrentSandboxes: 3,
      maxConcurrentSandboxesPerMember: 5,
      machineSizes: ['standard', 'large'],
      overageAllowed: true,
      features: { audit_log: false, sso: false, scim: false, mfa_enforcement: false }
    })
    expect(aggregateGrants([{ key: 'audit_log', value: false, perSeat: false, seats: null }, { key: 'audit_log', value: true, perSeat: false, seats: null }]).features).toEqual({
      audit_log: true,
      sso: false,
      scim: false,
      mfa_enforcement: false
    })
  })
})

describe('subscription grants (ENTITLEMENTS_MODE=on)', () => {
  it('grants the plan version on checkout, per seat, and the entitlement reads from the grants', async () => {
    const { h, auth, customer } = await team()
    await subscribe(h, customer, 2)
    expect(grantRows(h)).toEqual([
      { entitlement_key: 'machine_sizes', value_json: '["standard","large"]', per_seat: 0, seat_quantity: null, state: 'active', hold_reason: null, ends_at: null, revoked_reason: null, plan_version: 2 },
      { entitlement_key: 'max_concurrent_sandboxes', value_json: '3', per_seat: 1, seat_quantity: 2, state: 'active', hold_reason: null, ends_at: null, revoked_reason: null, plan_version: 2 },
      { entitlement_key: 'max_concurrent_sandboxes_per_member', value_json: '3', per_seat: 0, seat_quantity: null, state: 'active', hold_reason: null, ends_at: null, revoked_reason: null, plan_version: 2 },
      { entitlement_key: 'overage_allowed', value_json: 'true', per_seat: 0, seat_quantity: null, state: 'active', hold_reason: null, ends_at: null, revoked_reason: null, plan_version: 2 },
      { entitlement_key: 'sandbox_hours_monthly', value_json: '60', per_seat: 1, seat_quantity: 2, state: 'active', hold_reason: null, ends_at: null, revoked_reason: null, plan_version: 2 }
    ])
    const view = await h.call('GET', '/v1/billing/entitlements', { headers: auth })
    expect(view.body).toMatchObject({
      plan: 'team',
      planLabel: 'Team',
      includedSeconds: 120 * HOUR,
      limits: { maxConcurrentSandboxes: 6, maxConcurrentSandboxesPerMember: 3 },
      canStartSandbox: true
    })
    const audit = h.raw.prepare("SELECT action, actor FROM entitlement_audit WHERE source_type = 'subscription'").all()
    expect(audit).toHaveLength(5)
    expect(audit[0]).toEqual({ action: 'grant', actor: 'stripe_webhook' })
  })

  it('follows seats, holds on a failed payment, releases when paid, ends at period end, revokes on cancel', async () => {
    const { h, auth, customer } = await team()
    const subscription = await subscribe(h, customer, 2)
    const hours = () => grantRows(h).find((row) => row.entitlement_key === 'sandbox_hours_monthly')!

    // Seats 2 -> 4 (the portal or a membership sync changed the quantity).
    subscription.items.data[0]!.quantity = 4
    await h.webhook(stripeEvent('customer.subscription.updated', subscription))
    expect(hours()).toMatchObject({ seat_quantity: 4, state: 'active' })
    expect((await h.call('GET', '/v1/billing/entitlements', { headers: auth })).body.includedSeconds).toBe(240 * HOUR)

    subscription.status = 'past_due'
    await h.webhook(invoiceEvent('invoice.payment_failed', subscription.id, customer))
    expect(hours()).toMatchObject({ state: 'held', hold_reason: 'payment_past_due' })
    expect((await h.call('GET', '/v1/billing/entitlements', { headers: auth })).body.reason).toBe('payment_past_due')

    subscription.status = 'active'
    await h.webhook(invoiceEvent('invoice.paid', subscription.id, customer))
    expect(hours()).toMatchObject({ state: 'active', hold_reason: null })

    subscription.cancel_at_period_end = true
    await h.webhook(stripeEvent('customer.subscription.updated', subscription))
    expect(hours()).toMatchObject({ state: 'active', ends_at: PERIOD_END * 1000 })

    subscription.status = 'canceled'
    await h.webhook(stripeEvent('customer.subscription.deleted', subscription))
    expect(grantRows(h).every((row) => row.state === 'revoked' && row.revoked_reason === 'stripe_canceled')).toBe(true)
    const ended = await h.call('GET', '/v1/billing/entitlements', { headers: auth })
    expect(ended.body).toMatchObject({ canStartSandbox: false, reason: 'subscription_inactive' })
    const start = await h.controlPlane('/v1/internal/entitlements/check', { accountId: 'org:o1', machineSize: 'standard', runningSandboxes: 0 })
    expect(start.body).toMatchObject({ allow: false, reason: 'subscription_inactive' })

    // Revocation is terminal: a stale "active" read replayed later can't bring the grants back.
    subscription.status = 'active'
    await h.webhook(stripeEvent('customer.subscription.updated', subscription))
    expect(grantRows(h).every((row) => row.state === 'revoked')).toBe(true)
  })

  it('denies once a cancel-at-period-end grant has ended, even before Stripe says deleted', async () => {
    const { h, auth, customer } = await team()
    const subscription = await subscribe(h, customer)
    subscription.cancel_at_period_end = true
    await h.webhook(stripeEvent('customer.subscription.updated', subscription))
    h.setNow(PERIOD_END * 1000 + 1000)
    expect((await h.call('GET', '/v1/billing/entitlements', { headers: auth })).body).toMatchObject({
      canStartSandbox: false,
      reason: 'subscription_inactive'
    })
  })

  it('never lets an older read overwrite a newer one (out-of-order delivery)', async () => {
    const { h, customer } = await team()
    const subscription = await subscribe(h, customer, 2)
    const db = h.env.BILLING_DB
    const catalog = await loadCatalog(db)
    const row = { ...(await db.prepare('SELECT * FROM subscriptions').first<any>()), seats: 9, updated_at: 1 }
    const before = await grantsForSource(db, 'subscription', subscription.id)
    await applyProjection(db, {
      subjectId: 'org:o1',
      source: 'subscription',
      sourceId: subscription.id,
      projection: subscriptionProjection(catalog, row, before),
      syncedAt: 1,
      now: Date.now(),
      actor: 'test'
    })
    expect(grantRows(h).find((entry) => entry.entitlement_key === 'sandbox_hours_monthly')).toMatchObject({ seat_quantity: 2 })
  })

  it('keeps existing subscribers on their plan version (grandfathered) and gives new ones the current one', async () => {
    const { h, customer } = await team()
    await subscribe(h, customer, 1)
    const changed = repoCatalog()
    const team2 = changed.plans[0]!
    team2.versions.push({ ...team2.versions[0]!, version: 3, entitlements: { ...team2.versions[0]!.entitlements, sandbox_hours_monthly: { value: 40, perSeat: true } } })
    team2.currentVersion = 3
    await applyCatalog(h.env.BILLING_DB, changed, Date.now())
    const existing = await computeEntitlement(h.env, 'org:o1', Date.now())
    expect(existing.includedSeconds).toBe(60 * HOUR)

    const other = await h.desktopToken({ sub: 'u2', org: 'o2', orgRole: 'owner', email: 'b@example.com' })
    await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team', seats: 1 }, headers: { authorization: `Bearer ${other}` } })
    const customer2 = [...h.stripe.customers.keys()][1]!
    const sub2 = h.stripe.putSubscription({ customer: customer2, accountId: 'org:o2', basePrice: 'price_team_month', quantity: 1, periodStart: PERIOD_START, periodEnd: PERIOD_END })
    await h.webhook(checkoutCompleted({ customer: customer2, subscription: sub2.id, accountId: 'org:o2' }))
    expect((await computeEntitlement(h.env, 'org:o2', Date.now())).includedSeconds).toBe(40 * HOUR)
  })
})

describe('trial grants (ENTITLEMENTS_MODE=on)', () => {
  async function trialTeam(h: Awaited<ReturnType<typeof createHarness>>, sub: string, org: string, email: string) {
    const token = await h.desktopToken({ sub, org, orgRole: 'owner', email, emailVerified: true })
    const auth = { authorization: `Bearer ${token}` }
    return { auth, grant: await h.call('POST', '/v1/billing/trial', { headers: auth }) }
  }

  it('grants the trial plan: its hours, one sandbox at a time, no overage; a plan revokes it', async () => {
    const h = await createHarness({ ENTITLEMENTS_MODE: 'on' })
    const { auth, grant } = await trialTeam(h, 'u1', 'o1', 'a@acme.dev')
    expect(grant.status).toBe(200)
    expect(grant.body).toMatchObject({ status: 'trial', includedSeconds: 2 * HOUR, limits: { maxConcurrentSandboxes: 1, maxConcurrentSandboxesPerMember: 1 } })
    expect(grantRows(h, 'trial').map((row) => [row.entitlement_key, row.value_json, row.state])).toEqual([
      ['machine_sizes', '["standard","large"]', 'active'],
      ['max_concurrent_sandboxes', '1', 'active'],
      ['max_concurrent_sandboxes_per_member', '1', 'active'],
      ['overage_allowed', 'false', 'active'],
      ['sandbox_hours_lifetime', '2', 'active']
    ])

    await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team', seats: 1 }, headers: auth })
    const customer = [...h.stripe.customers.keys()][0]!
    await subscribe(h, customer, 1)
    await h.call('GET', '/v1/billing/entitlements', { headers: auth })
    expect(grantRows(h, 'trial').every((row) => row.state === 'revoked' && row.revoked_reason === 'superseded_by_plan')).toBe(true)
  })

  it('takes new trials\' hours from the catalog; a granted trial keeps what it was granted', async () => {
    const h = await createHarness({ ENTITLEMENTS_MODE: 'on' })
    await trialTeam(h, 'u1', 'o1', 'a@acme.dev')
    const changed = repoCatalog()
    const trial = changed.plans.find((plan) => plan.id === 'trial')!
    trial.versions.push({ ...trial.versions[0]!, version: 2, entitlements: { ...trial.versions[0]!.entitlements, sandbox_hours_lifetime: { value: 3 } } })
    trial.currentVersion = 2
    await applyCatalog(h.env.BILLING_DB, changed, Date.now())
    const second = await trialTeam(h, 'u2', 'o2', 'b@other.dev')
    expect(second.grant.body.includedSeconds).toBe(3 * HOUR)
    expect(second.grant.body.offers.trial).toBeNull()
    expect((await computeEntitlement(h.env, 'org:o1', Date.now())).includedSeconds).toBe(2 * HOUR)
    const offers = await h.call('GET', '/v1/cloud-setup/offers')
    expect(offers.body.trial).toEqual({ includedSeconds: 3 * HOUR })
  })
})

describe('manual grants', () => {
  it('add on top of the plan while live, and stop at their end or when revoked', async () => {
    const { h, customer } = await team()
    await subscribe(h, customer, 1)
    const db = h.env.BILLING_DB
    const now = Date.now()
    await putManualGrant(db, {
      subjectId: 'org:o1',
      source: 'promo',
      sourceId: 'launch-week',
      entitlements: { sandbox_hours_monthly: { value: 10 }, max_concurrent_sandboxes: { value: 2 } },
      startsAt: now - 1000,
      endsAt: now + 3600_000,
      actor: 'ops:test',
      now
    })
    const boosted = await computeEntitlement(h.env, 'org:o1', now)
    expect(boosted.includedSeconds).toBe(70 * HOUR)
    expect(boosted.limits.maxConcurrentSandboxes).toBe(5)
    expect((await computeEntitlement(h.env, 'org:o1', now + 3600_000)).includedSeconds).toBe(60 * HOUR)
    await revokeManualGrant(db, { subjectId: 'org:o1', source: 'promo', sourceId: 'launch-week', reason: 'ops', actor: 'ops:test', now })
    expect((await computeEntitlement(h.env, 'org:o1', now)).includedSeconds).toBe(60 * HOUR)
    await expect(
      putManualGrant(db, { subjectId: 'org:o1', source: 'manual', sourceId: 't1', entitlements: { gpu: { value: 1 } }, startsAt: now, endsAt: null, actor: 'ops', now })
    ).rejects.toThrow(/unknown entitlement key/)
  })
})

describe('rollout', () => {
  it('backfills grants for subscriptions and trials written while the mode was off', async () => {
    const { h, customer } = await team({ mode: 'off' })
    await subscribe(h, customer, 3)
    expect(grantRows(h)).toEqual([])
    h.env.ENTITLEMENTS_MODE = 'shadow'
    expect(await backfillGrants(h.env, Date.now())).toEqual({ subscriptions: 1, trials: 0, failed: 0 })
    expect(grantRows(h).find((row) => row.entitlement_key === 'max_concurrent_sandboxes')).toMatchObject({ seat_quantity: 3, state: 'active' })
    // Idempotent: nothing left to do.
    expect(await backfillGrants(h.env, Date.now())).toEqual({ subscriptions: 0, trials: 0, failed: 0 })
  })

  it('records a shadow diff when the resolver disagrees, and still serves the legacy answer', async () => {
    const { h, auth, customer } = await team({ mode: 'shadow' })
    await subscribe(h, customer, 1)
    // Make the D1 catalog disagree with the legacy catalog.
    h.raw.exec(`UPDATE plan_versions SET entitlements_json = replace(entitlements_json, '"value":60', '"value":50') WHERE plan_id = 'team'`)
    h.raw.exec(`UPDATE entitlement_grants SET value_json = '50' WHERE entitlement_key = 'sandbox_hours_monthly'`)
    const view = await h.call('GET', '/v1/billing/entitlements', { headers: auth })
    expect(view.body.includedSeconds).toBe(60 * HOUR)
    const diffs = h.raw.prepare('SELECT surface, diff_json FROM entitlement_shadow_diffs').all() as Array<{ surface: string; diff_json: string }>
    expect(diffs[0]!.surface).toBe('desktop')
    expect(JSON.parse(diffs[0]!.diff_json)).toContain('includedSeconds: 216000 != 180000')
    // The guard for the shadow project would (rightly) fail this test: clear it.
    h.raw.exec('DELETE FROM entitlement_shadow_diffs')
  })

  it('diffs leaf paths', () => {
    expect(diffEntitlements({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 3] } })).toEqual(['b.c.1: 2 != 3'])
  })
})
