import { describe, expect, it } from 'vitest'
import { checkoutCompleted } from './stripe-fake'
import { createHarness } from './harness'
import { authOrgMemberCheck, type OrgMemberAnswer } from '../src/team-plans'
import type { Env } from '../src/env'

const HOUR = 3600
const PERIOD_START = Math.floor(Date.now() / 1000) - 5 * 24 * HOUR

/** Team o1 subscribed (by its owner u1); u2 is a member of o1 and of o2 (no plan). */
async function setup() {
  const h = await createHarness()
  const owner = await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'owner' })
  await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team', seats: 2 }, headers: { authorization: `Bearer ${owner}` } })
  const customer = [...h.stripe.customers.keys()][0]!
  const subscription = h.stripe.putSubscription({
    customer,
    accountId: 'org:o1',
    basePrice: 'price_team_month',
    quantity: 2,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_START + 30 * 24 * HOUR
  })
  await h.webhook(checkoutCompleted({ customer, subscription: subscription.id, accountId: 'org:o1' }))
  // u2 signed in on their personal account.
  const personal = await h.desktopToken({ sub: 'u2' })
  // Auth answers for the user it reads from the forwarded billing token.
  const roster: Record<string, OrgMemberAnswer> = {
    o1: { member: true, billingEnabled: true },
    o2: { member: true, billingEnabled: true }
  }
  const forwarded: string[] = []
  h.setOrgMember(async (orgId, billingToken) => {
    forwarded.push(`${orgId}:${billingToken === personal ? 'caller' : 'other'}`)
    return billingToken === personal ? (roster[orgId] ?? { member: false }) : { member: false }
  })
  return { h, roster, forwarded, personal, auth: { authorization: `Bearer ${personal}` } }
}

describe('POST /v1/billing/team-plans', () => {
  it('returns plan state for teams the caller is on, asking auth with the caller’s own token', async () => {
    const { h, auth, forwarded } = await setup()
    const result = await h.call('POST', '/v1/billing/team-plans', { body: { orgIds: ['o1', 'o2', 'o1'] }, headers: auth })
    expect(result.status).toBe(200)
    expect(result.body).toEqual({
      teams: [
        { orgId: 'o1', plan: 'team', planLabel: expect.any(String), canStartSandbox: true },
        { orgId: 'o2', plan: null, planLabel: null, canStartSandbox: false }
      ]
    })
    // Once per team, with the caller's token (auth names the user; nothing else is trusted).
    expect(forwarded.sort()).toEqual(['o1:caller', 'o2:caller'])
  })

  it('leaves out teams the caller is not on, was removed from, or that have billing off', async () => {
    const { h, auth, roster } = await setup()
    const stranger = await h.desktopToken({ sub: 'u9' })
    const none = await h.call('POST', '/v1/billing/team-plans', { body: { orgIds: ['o1', 'o2'] }, headers: { authorization: `Bearer ${stranger}` } })
    expect(none.body).toEqual({ teams: [] })

    // Removed from o1 at the provider: gone at once (auth reads the live roster).
    roster.o1 = { member: false }
    // Billing turned off for o2's account.
    roster.o2 = { member: true, billingEnabled: false }
    expect((await h.call('POST', '/v1/billing/team-plans', { body: { orgIds: ['o1', 'o2'] }, headers: auth })).body).toEqual({ teams: [] })
  })

  it('fails closed when auth cannot or will not answer', async () => {
    const { h, auth } = await setup()
    h.setOrgMember(async () => null)
    expect((await h.call('POST', '/v1/billing/team-plans', { body: { orgIds: ['o1'] }, headers: auth })).body).toEqual({ teams: [] })
  })

  it('needs a billing token and a bounded, well-formed list', async () => {
    const { h, auth } = await setup()
    expect((await h.call('POST', '/v1/billing/team-plans', { body: { orgIds: ['o1'] } })).status).toBe(401)
    const sandboxToken = await h.desktopToken({ sub: 'u2' }, { purpose: 'sandbox' })
    expect((await h.call('POST', '/v1/billing/team-plans', { body: { orgIds: ['o1'] }, headers: { authorization: `Bearer ${sandboxToken}` } })).status).toBe(401)
    for (const body of [{}, { orgIds: [] }, { orgIds: ['o/../x'] }, { orgIds: Array.from({ length: 11 }, (_, i) => `o${i}`) }, { orgIds: ['o1'], extra: 1 }]) {
      expect((await h.call('POST', '/v1/billing/team-plans', { body, headers: auth })).status).toBe(400)
    }
  })
})

describe('authOrgMemberCheck', () => {
  const env = { AUTH_INTERNAL_URL: 'https://auth.test', MEMBERSHIP_SYNC_TOKEN: 'ms_test_0123456789abcdef0123456789abcdef, ms_old_x' } as Env

  it('forwards the caller’s billing token with the membership secret and accepts only a matching answer', async () => {
    const seen: Array<{ url: string; auth: string | null; body: unknown }> = []
    const check = authOrgMemberCheck(env, (async (url: URL, init: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) })
      return Response.json({ orgId: 'o1', member: true, billingEnabled: true })
    }) as unknown as typeof fetch)
    expect(await check('o1', 'bt_caller')).toEqual({ member: true, billingEnabled: true })
    expect(seen).toEqual([
      {
        url: 'https://auth.test/v1/internal/billing/org-member',
        auth: 'Bearer ms_test_0123456789abcdef0123456789abcdef',
        body: { orgId: 'o1', billingToken: 'bt_caller' }
      }
    ])
    // An answer about another org is not an answer.
    expect(await check('o2', 'bt_caller')).toBeNull()
  })

  it('is null when unconfigured, refused, unreachable or malformed', async () => {
    const ok = (async () => Response.json({ orgId: 'o1', member: true })) as unknown as typeof fetch
    expect(await authOrgMemberCheck({} as Env, ok)('o1', 'bt')).toBeNull()
    // e.g. 401 invalid_billing_token for a dev/operator token auth didn't sign.
    expect(await authOrgMemberCheck(env, (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch)('o1', 'bt')).toBeNull()
    expect(
      await authOrgMemberCheck(env, (async () => {
        throw new TypeError('down')
      }) as unknown as typeof fetch)('o1', 'bt')
    ).toBeNull()
    expect(await authOrgMemberCheck(env, (async () => Response.json({ member: 'yes' })) as unknown as typeof fetch)('o1', 'bt')).toBeNull()
  })
})
