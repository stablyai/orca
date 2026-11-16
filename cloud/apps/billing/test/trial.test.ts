import { describe, expect, it } from 'vitest'
import { checkoutCompleted } from './stripe-fake'
import { createHarness } from './harness'
import { TRIAL_GRANTS_PER_IP_PER_DAY, isDisposableEmailDomain, normalizeEmail } from '../src/trial'

const HOUR = 3600

type Harness = Awaited<ReturnType<typeof createHarness>>

async function as(h: Harness, claims: Parameters<Harness['desktopToken']>[0], ip = '203.0.113.7') {
  const token = await h.desktopToken(claims)
  return { authorization: `Bearer ${token}`, 'cf-connecting-ip': ip }
}

function segment(accountId: string, id: string, hours: number, endedAt = Date.now() - 60_000) {
  return { usageId: id, accountId, sandboxId: 'sbx_t', machineSize: 'standard', startedAt: endedAt - hours * HOUR * 1000, endedAt, userId: 'u1' }
}

function startCheck(accountId: string, runningSandboxes = 0) {
  return { accountId, machineSize: 'standard', runningSandboxes, userId: 'u1', runningSandboxesForUser: runningSandboxes }
}

describe('trial grant', () => {
  it('offers a new team 2 sandbox hours, then grants them once with no card', async () => {
    const h = await createHarness()
    const owner = await as(h, { sub: 'u1', org: 'o1', orgRole: 'owner', email: 'neil@acme.dev' })
    const before = await h.call('GET', '/v1/billing/entitlements', { headers: owner })
    expect(before.body.reason).toBe('no_subscription')
    expect(before.body.offers.trial).toEqual({ includedSeconds: 7200 })
    expect(before.body.trial).toBeNull()

    const granted = await h.call('POST', '/v1/billing/trial', { headers: owner })
    expect(granted.status).toBe(200)
    expect(granted.body).toMatchObject({
      status: 'trial',
      plan: null,
      canStartSandbox: true,
      reason: null,
      includedSeconds: 7200,
      remainingIncludedSeconds: 7200,
      trial: { includedSeconds: 7200, usedSeconds: 0, remainingSeconds: 7200, exhausted: false },
      limits: { maxConcurrentSandboxes: 1, maxConcurrentSandboxesPerMember: 1 },
      overage: { optedIn: false, active: false }
    })
    // Once granted it's no longer "on offer"; Stripe was never called.
    expect(granted.body.offers.trial).toBeNull()
    expect(h.stripe.calls).toHaveLength(0)

    // Idempotent: asking again (any member) returns the same trial.
    const member = await as(h, { sub: 'u2', org: 'o1', orgRole: 'member', email: 'sam@acme.dev' })
    const again = await h.call('POST', '/v1/billing/trial', { headers: member })
    expect(again.status).toBe(200)
    expect(again.body.trial.grantedAt).toBe(granted.body.trial.grantedAt)
  })

  it('needs a team: a personal account is offered it but cannot claim it', async () => {
    const h = await createHarness()
    const solo = await as(h, { sub: 'u1', email: 'neil@acme.dev' })
    const view = await h.call('GET', '/v1/billing/entitlements', { headers: solo })
    expect(view.body.reason).toBe('no_subscription')
    expect(view.body.offers.trial).toEqual({ includedSeconds: 7200 })
    expect(await h.call('POST', '/v1/billing/trial', { headers: solo })).toEqual({ status: 409, body: { error: 'team_required' } })
  })
})

describe('trial abuse limits', () => {
  it('gives each Orca user one trial: their second team is refused', async () => {
    const h = await createHarness()
    expect((await h.call('POST', '/v1/billing/trial', { headers: await as(h, { sub: 'u1', org: 'o1', email: 'a@acme.dev' }) })).status).toBe(200)
    const second = await as(h, { sub: 'u1', org: 'o2', orgRole: 'owner', email: 'a@acme.dev' })
    expect(await h.call('POST', '/v1/billing/trial', { headers: second })).toEqual({ status: 403, body: { error: 'trial_unavailable' } })
    const view = await h.call('GET', '/v1/billing/entitlements', { headers: second })
    expect(view.body.reason).toBe('trial_unavailable')
    expect(view.body.offers.trial).toBeNull()
    expect(view.body.canStartSandbox).toBe(false)
  })

  it('keys verified email after normalization (+tags, Gmail dots)', async () => {
    const h = await createHarness()
    await h.call('POST', '/v1/billing/trial', { headers: await as(h, { sub: 'u1', org: 'o1', email: 'neil.parker@gmail.com' }) })
    const alias = await as(h, { sub: 'u9', org: 'o9', email: 'NeilParker+cloud@googlemail.com' })
    expect((await h.call('POST', '/v1/billing/trial', { headers: alias })).body).toEqual({ error: 'trial_unavailable' })
  })

  it('refuses unverified, missing and disposable emails', async () => {
    const h = await createHarness()
    for (const claims of [
      { sub: 'u1', org: 'o1', email: 'a@acme.dev', emailVerified: false },
      { sub: 'u2', org: 'o2' },
      { sub: 'u3', org: 'o3', email: 'x@mailinator.com' },
      { sub: 'u4', org: 'o4', email: 'x@inbox.yopmail.com' }
    ]) {
      expect((await h.call('POST', '/v1/billing/trial', { headers: await as(h, claims) })).body).toEqual({ error: 'trial_unavailable' })
    }
    expect(isDisposableEmailDomain('gmail.com')).toBe(false)
    expect(normalizeEmail('A.B+x@Gmail.com')).toEqual({ address: 'ab@gmail.com', domain: 'gmail.com' })
  })

  it('keys the GitHub user from the token and the GitHub owner from the binding', async () => {
    const h = await createHarness()
    await h.call('POST', '/v1/billing/trial', { headers: await as(h, { sub: 'u1', org: 'o1', email: 'a@acme.dev', githubUserId: '42' }) })
    const sameGithub = await as(h, { sub: 'u2', org: 'o2', email: 'b@other.dev', githubUserId: '42' })
    expect((await h.call('POST', '/v1/billing/trial', { headers: sameGithub })).body).toEqual({ error: 'trial_unavailable' })

    // o1 binds GitHub org 777; o3 binds the same owner before asking: no trial for o3.
    expect((await h.controlPlane('/v1/internal/trial/github', { accountId: 'org:o1', githubOwnerId: '777' })).body).toEqual({ revoked: false })
    expect((await h.controlPlane('/v1/internal/trial/github', { accountId: 'org:o3', githubOwnerId: '777' })).body).toEqual({ revoked: false })
    const o3 = await as(h, { sub: 'u3', org: 'o3', email: 'c@third.dev' })
    expect((await h.call('GET', '/v1/billing/entitlements', { headers: o3 })).body.reason).toBe('trial_unavailable')
    expect((await h.call('POST', '/v1/billing/trial', { headers: o3 })).status).toBe(403)

    // o4 gets a trial first, then binds the already-used owner: its trial is revoked.
    const o4 = await as(h, { sub: 'u4', org: 'o4', email: 'd@fourth.dev' })
    expect((await h.call('POST', '/v1/billing/trial', { headers: o4 })).status).toBe(200)
    expect((await h.controlPlane('/v1/internal/trial/github', { accountId: 'org:o4', githubOwnerId: '777' })).body).toEqual({ revoked: true })
    const revoked = await h.controlPlane('/v1/internal/entitlements/check', startCheck('org:o4'))
    expect(revoked.body).toMatchObject({ allow: false, reason: 'trial_unavailable', suspendRunning: true })
    expect((await h.controlPlane('/v1/internal/trial/github', { accountId: 'org:o4', githubOwnerId: 'x' })).status).toBe(400)
  })

  it('ignores GitHub bindings on personal accounts and treats dev:org: like org:', async () => {
    const h = await createHarness()
    for (const accountId of ['user:u1', 'dev:user:u2']) {
      expect((await h.controlPlane('/v1/internal/trial/github', { accountId, githubOwnerId: '555', githubUserId: '9' })).body).toEqual({ revoked: false })
    }
    expect(h.raw.prepare('SELECT COUNT(*) AS n FROM trial_claims').get()).toEqual({ n: 0 })
    // A personal account's binding doesn't block a team that later uses the same owner.
    await h.call('POST', '/v1/billing/trial', { headers: await as(h, { sub: 'u3', org: 'o3', email: 'c@acme.dev' }) })
    expect((await h.controlPlane('/v1/internal/trial/github', { accountId: 'org:o3', githubOwnerId: '555' })).body).toEqual({ revoked: false })
    // dev:org: accounts are teams: a binding records the owner, and reusing it revokes.
    expect((await h.controlPlane('/v1/internal/trial/github', { accountId: 'dev:org:x', githubOwnerId: '555' })).body).toEqual({ revoked: false })
    expect(h.raw.prepare("SELECT COUNT(*) AS n FROM trial_claims WHERE account_id = 'dev:org:x'").get()).toEqual({ n: 1 })
  })

  it('rate limits grants per IP', async () => {
    const h = await createHarness()
    for (let i = 0; i < TRIAL_GRANTS_PER_IP_PER_DAY; i++) {
      const ok = await h.call('POST', '/v1/billing/trial', { headers: await as(h, { sub: `u${i}`, org: `o${i}`, email: `p${i}@acme.dev` }) })
      expect(ok.status).toBe(200)
    }
    const over = await as(h, { sub: 'ux', org: 'ox', email: 'px@acme.dev' })
    expect((await h.call('POST', '/v1/billing/trial', { headers: over })).body).toEqual({ error: 'trial_unavailable' })
    const otherIp = await as(h, { sub: 'ux', org: 'ox', email: 'px@acme.dev' }, '198.51.100.1')
    expect((await h.call('POST', '/v1/billing/trial', { headers: otherIp })).status).toBe(200)
  })
})

describe('trial metering and limits', () => {
  it('meters usage against the trial, runs 1 sandbox at a time, never overage, and ends at used up', async () => {
    const h = await createHarness()
    const owner = await as(h, { sub: 'u1', org: 'o1', orgRole: 'owner', email: 'a@acme.dev' })
    await h.call('POST', '/v1/billing/trial', { headers: owner })

    expect((await h.controlPlane('/v1/internal/entitlements/check', startCheck('org:o1'))).body).toMatchObject({ allow: true, maxConcurrentSandboxes: 1 })
    // Concurrency 1: a second sandbox while one runs is refused.
    expect((await h.controlPlane('/v1/internal/entitlements/check', startCheck('org:o1', 1))).body).toMatchObject({ allow: false, reason: 'concurrency_limit' })
    // Overage can't be turned on during a trial.
    expect((await h.call('POST', '/v1/billing/overage', { body: { enabled: true }, headers: owner })).status).toBe(409)

    const first = await h.controlPlane('/v1/internal/usage', segment('org:o1', 'use_1', 1.5))
    expect(first.body).toMatchObject({ recorded: true, overageSeconds: 0, canStartSandbox: true, suspendRunning: false })
    // A retried report doesn't count twice.
    await h.controlPlane('/v1/internal/usage', segment('org:o1', 'use_1', 1.5))
    const mid = await h.call('GET', '/v1/billing/entitlements', { headers: owner })
    expect(mid.body.trial).toMatchObject({ usedSeconds: 5400, remainingSeconds: 1800, exhausted: false })
    expect(mid.body.usageWarningPercent).toBe(75)

    const last = await h.controlPlane('/v1/internal/usage', segment('org:o1', 'use_2', 1))
    expect(last.body).toMatchObject({ overageSeconds: 0, canStartSandbox: false, reason: 'trial_used_up', suspendRunning: true })
    expect((await h.controlPlane('/v1/internal/entitlements/check', startCheck('org:o1'))).body).toMatchObject({ allow: false, reason: 'trial_used_up' })
    const usedUp = await h.call('GET', '/v1/billing/entitlements', { headers: owner })
    expect(usedUp.body).toMatchObject({ status: 'trial', reason: 'trial_used_up', remainingIncludedSeconds: 0, trial: { exhausted: true } })
    expect(usedUp.body.offers.trial).toBeNull()
    expect(h.stripe.calls.some((call) => call.path.includes('meter_events'))).toBe(false)
  })

  it('ends the trial when a plan starts; unused trial hours lapse', async () => {
    const h = await createHarness()
    const owner = await as(h, { sub: 'u1', org: 'o1', orgRole: 'owner', email: 'a@acme.dev' })
    await h.call('POST', '/v1/billing/trial', { headers: owner })
    await h.controlPlane('/v1/internal/usage', segment('org:o1', 'use_1', 0.5))

    expect((await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team', seats: 1 }, headers: owner })).status).toBe(200)
    const customer = [...h.stripe.customers.keys()][0]!
    const periodStart = Math.floor(Date.now() / 1000) - 60
    const subscription = h.stripe.putSubscription({
      customer,
      accountId: 'org:o1',
      basePrice: 'price_team_month',
      quantity: 1,
      periodStart,
      periodEnd: periodStart + 30 * 24 * HOUR
    })
    await h.webhook(checkoutCompleted({ customer, subscription: subscription.id, accountId: 'org:o1' }))

    const plan = await h.call('GET', '/v1/billing/entitlements', { headers: owner })
    expect(plan.body).toMatchObject({ plan: 'team', status: 'active', trial: null, includedSeconds: 60 * HOUR, usedSeconds: 0 })
    expect(plan.body.limits.maxConcurrentSandboxes).toBe(3)
    // No second trial later, even if the plan lapses.
    expect((await h.call('POST', '/v1/billing/trial', { headers: owner })).body).toEqual({ error: 'trial_unavailable' })
  })

  it('never offers a trial to a team that already had a plan', async () => {
    const h = await createHarness()
    const owner = await as(h, { sub: 'u1', org: 'o1', orgRole: 'owner', email: 'a@acme.dev' })
    await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team', seats: 1 }, headers: owner })
    const customer = [...h.stripe.customers.keys()][0]!
    const periodStart = Math.floor(Date.now() / 1000) - 40 * 24 * HOUR
    const subscription = h.stripe.putSubscription({
      customer,
      accountId: 'org:o1',
      basePrice: 'price_team_month',
      quantity: 1,
      periodStart,
      periodEnd: periodStart + 30 * 24 * HOUR,
      status: 'canceled'
    })
    await h.webhook(checkoutCompleted({ customer, subscription: subscription.id, accountId: 'org:o1' }))
    const view = await h.call('GET', '/v1/billing/entitlements', { headers: owner })
    expect(view.body.reason).toBe('subscription_inactive')
    expect(view.body.offers.trial).toBeNull()
    expect((await h.call('POST', '/v1/billing/trial', { headers: owner })).status).toBe(403)
  })
})
