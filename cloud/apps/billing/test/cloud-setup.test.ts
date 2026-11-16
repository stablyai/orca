import { describe, expect, it } from 'vitest'
import type { TrialPort, SetupTrial } from '../src/cloud-setup-trial'
import { normalizeRepo } from '../src/cloud-setup'
import type { Env } from '../src/env'
import { checkoutCompleted } from './stripe-fake'
import { CONTROL_TOKEN, createHarness } from './harness'

const SYNC = 'sync_test_0123456789abcdef0123456789abcdef'
const REPO = 'https://github.com/Acme/Web.git'

/** In-memory trial backend: one 2-hour trial per account, exhausted on demand. */
function fakeTrials(options: { refuse?: boolean } = {}) {
  const trials = new Map<string, SetupTrial>()
  const grants: string[] = []
  const port: TrialPort = {
    offeredSeconds: () => 7200,
    current: async (_env, accountId) => trials.get(accountId) ?? null,
    grant: async (_env, input) => {
      grants.push(input.accountId)
      if (options.refuse) {
        return { ok: false, reason: 'trial_unavailable' }
      }
      const trial = trials.get(input.accountId) ?? { includedSeconds: 7200, usedSeconds: 0, exhausted: false }
      trials.set(input.accountId, trial)
      return { ok: true, trial }
    }
  }
  return { port, trials, grants }
}

async function setup(options: { refuseTrial?: boolean; env?: Partial<Env> } = {}) {
  const h = await createHarness({
    MEMBERSHIP_SYNC_TOKEN: SYNC,
    CLOUD_SETUP_PAGES_URL: 'https://auth.test',
    SANDBOX_CONTROL_URL: 'https://cp.test',
    ...options.env
  })
  const trials = fakeTrials({ refuse: options.refuseTrial })
  h.setTrial(trials.port)
  const sync = { authorization: `Bearer ${SYNC}` }
  const personal = { authorization: `Bearer ${await h.desktopToken({ sub: 'u1', email: 'neil@acme.dev' })}` }
  const create = async (body: Record<string, unknown> = { repo: REPO, needs: ['plan', 'github'], device: 'MacBook Pro' }, auth = personal) =>
    h.call('POST', '/v1/cloud-setup/sessions', { body, headers: auth })
  const poll = (id: string, auth = personal) => h.call('GET', `/v1/cloud-setup/sessions/${id}`, { headers: auth })
  const pages = {
    redeem: (sessionId: string, ticket: string) => h.call('POST', '/v1/internal/cloud-setup/redeem', { body: { sessionId, ticket }, headers: sync }),
    read: (id: string, userId = 'u1') => h.call('GET', `/v1/internal/cloud-setup/sessions/${id}?userId=${userId}`, { headers: sync }),
    post: (id: string, action: string, body: unknown) => h.call('POST', `/v1/internal/cloud-setup/sessions/${id}/${action}`, { body, headers: sync })
  }
  return { h, trials, create, poll, pages, personal }
}

function ticketOf(url: string): { session: string; ticket: string } {
  const parsed = new URL(url)
  return { session: parsed.searchParams.get('session')!, ticket: parsed.searchParams.get('ticket')! }
}

describe('cloud setup sessions', () => {
  it('publishes the trial and prices for the pages without auth', async () => {
    const { h } = await setup()
    const offers = await h.call('GET', '/v1/cloud-setup/offers')
    expect(offers.body.trial).toEqual({ includedSeconds: 7200 })
    expect(offers.body.team.monthlyPriceLabel).toMatch(/per seat per month/)
  })

  it('asks the control plane for the GitHub install URL over its service binding when bound', async () => {
    // Same-account workers.dev Workers can't fetch each other (Cloudflare 1042): use the binding.
    const viaBinding: string[] = []
    const binding = {
      fetch: async (input: RequestInfo | URL) => {
        viaBinding.push(String(input))
        return Response.json({ access: 'missing', url: 'https://github.com/apps/orca-cloud/installations/new?state=s' })
      }
    } as unknown as Fetcher
    const { h, create, pages } = await setup({ env: { SANDBOX_CONTROL: binding } })
    const viaFetch: string[] = []
    h.setFetch(async (input) => {
      viaFetch.push(String(input))
      return new Response('error code: 1042', { status: 404 })
    })
    const { session, ticket } = ticketOf((await create()).body.url)
    await pages.redeem(session, ticket)
    await pages.post(session, 'team', { userId: 'u1', orgId: 'o_acme', name: 'acme', created: true })
    const install = await pages.post(session, 'github', { userId: 'u1' })
    expect(install.body).toEqual({ access: 'missing', url: 'https://github.com/apps/orca-cloud/installations/new?state=s' })
    expect(viaBinding.map((url) => new URL(url).pathname)).toEqual(['/v1/internal/github/install-url'])
    expect(viaFetch.filter((url) => url.includes('install-url'))).toEqual([])
  })

  it('normalizes GitHub repositories', () => {
    expect(normalizeRepo('https://github.com/Acme/Web.git/')).toBe('https://github.com/acme/web')
    expect(normalizeRepo('git@github.com:acme/web.git')).toBe('https://github.com/acme/web')
    expect(normalizeRepo('https://gitlab.com/acme/web')).toBeNull()
  })

  it('chains a new user through team (trial granted), then GitHub, then finishes', async () => {
    const { h, trials, create, poll, pages, personal } = await setup()
    const created = await create()
    expect(created.status).toBe(201)
    expect(created.body.id).toMatch(/^cs_[A-Za-z0-9_-]{22}$/)
    const { session, ticket } = ticketOf(created.body.url)
    expect(created.body.url).toMatch(/^https:\/\/auth\.test\/cloud\/setup\/start\?/)
    expect(session).toBe(created.body.id)

    // Personal account: the team step is added and is the active one.
    expect((await poll(session)).body.steps).toEqual([
      { id: 'account', state: 'done' },
      { id: 'team', state: 'active' },
      { id: 'plan', state: 'pending' },
      { id: 'github', state: 'pending' }
    ])

    // The ticket redeems exactly once, and only with the right value.
    expect((await pages.redeem(session, 'x'.repeat(43))).status).toBe(404)
    expect((await pages.redeem(session, ticket)).body).toEqual({ userId: 'u1' })
    expect((await pages.redeem(session, ticket)).status).toBe(404)
    // "Copy setup link" mints a fresh one-time link for another browser.
    const link = await h.call('POST', `/v1/cloud-setup/sessions/${session}/link`, { headers: personal })
    expect((await pages.redeem(session, ticketOf(link.body.url).ticket)).body).toEqual({ userId: 'u1' })

    // Pages read it as the session's user only.
    expect((await pages.read(session, 'u2')).status).toBe(404)
    const read = await pages.read(session)
    expect(read.body).toMatchObject({ ownerHint: 'acme', device: 'MacBook Pro', needs: ['plan', 'github', 'team'] })

    const bound = await pages.post(session, 'team', { userId: 'u1', orgId: 'o_acme', name: 'acme', created: true, githubOwnerId: 42 })
    expect(bound.body).toEqual({ ok: true, trial: 'granted' })
    expect(trials.grants).toEqual(['org:o_acme'])
    const afterTeam = (await poll(session)).body
    expect(afterTeam.team).toEqual({ orgId: 'o_acme', name: 'acme', created: true })
    expect(afterTeam.plan).toBe('trial')
    expect(afterTeam.trial).toEqual({ includedSeconds: 7200, usedSeconds: 0, exhausted: false })
    expect(afterTeam.steps.map((s: { state: string }) => s.state)).toEqual(['done', 'done', 'done', 'active'])

    // GitHub: the control plane hands out the install URL, then reports the bind.
    const seen: string[] = []
    h.setFetch(async (input) => {
      seen.push(String(input))
      return Response.json({ access: 'missing', url: 'https://github.com/apps/orca-cloud/installations/new?state=s' })
    })
    const install = await pages.post(session, 'github', { userId: 'u1', githubUserId: 7, githubLogin: 'neil-acme' })
    expect(install.body).toEqual({ access: 'missing', url: 'https://github.com/apps/orca-cloud/installations/new?state=s' })
    const asked = new URL(seen[0]!)
    expect(asked.origin + asked.pathname).toBe('https://cp.test/v1/internal/github/install-url')
    expect(Object.fromEntries(asked.searchParams)).toEqual({
      accountId: 'org:o_acme',
      userId: 'u1',
      repo: 'https://github.com/acme/web',
      session,
      githubUserId: '7',
      githubLogin: 'neil-acme'
    })

    const event = await h.controlPlane('/v1/internal/cloud-setup/github', {
      sessionId: session,
      accountId: 'org:o_acme',
      repo: 'https://github.com/Acme/web',
      state: 'done'
    })
    expect(event.body).toEqual({ ok: true, matched: 1 })
    const finished = (await poll(session)).body
    expect(finished.finished).toBe(true)
    expect(finished.error).toBeNull()
  })

  it('sends a team whose trial is used up through the plan page and Checkout, which return to the setup pages', async () => {
    const { h, trials, create, poll, pages } = await setup()
    trials.trials.set('org:o1', { includedSeconds: 7200, usedSeconds: 7200, exhausted: true })
    const owner = { authorization: `Bearer ${await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'owner' })}` }
    const created = await create({ needs: ['plan'] }, owner)
    const id = created.body.id
    // The active team is kept: team done, plan active.
    expect((await poll(id, owner)).body.steps).toEqual([
      { id: 'account', state: 'done' },
      { id: 'team', state: 'done' },
      { id: 'plan', state: 'active' }
    ])
    expect((await pages.post(id, 'checkout', { userId: 'u1', orgRole: 'member', interval: 'year' })).status).toBe(403)
    const checkout = await pages.post(id, 'checkout', { userId: 'u1', orgRole: 'owner', interval: 'year', email: 'a@acme.dev' })
    expect(checkout.status).toBe(200)
    const call = h.stripe.calls.find((c) => c.method === 'POST' && c.path === '/v1/checkout/sessions')!
    expect(call.form.get('line_items[0][price]')).toBe('price_team_year')
    expect(call.form.get('success_url')).toBe(`https://auth.test/cloud/setup/next?session=${id}&from=checkout&checkout=success`)
    expect(call.form.get('cancel_url')).toBe(`https://auth.test/cloud/setup/plan?session=${id}&checkout=canceled`)
    expect(call.form.get('metadata[setup_session_id]')).toBe(id)
    expect((await poll(id, owner)).body.steps[2]).toEqual({ id: 'plan', state: 'active', detail: 'checkout' })

    // Canceled: the tracker gets checkout_canceled and the plan row fails.
    await pages.post(id, 'error', { userId: 'u1', kind: 'checkout_canceled' })
    const canceled = (await poll(id, owner)).body
    expect(canceled.error).toEqual({ kind: 'checkout_canceled' })
    expect(canceled.steps[2].state).toBe('failed')

    // Paid: the subscription ends the plan step.
    const customer = [...h.stripe.customers.keys()][0]!
    const subscription = h.stripe.putSubscription({
      customer,
      accountId: 'org:o1',
      basePrice: 'price_team_year',
      quantity: 1,
      periodStart: Math.floor(Date.now() / 1000),
      periodEnd: Math.floor(Date.now() / 1000) + 365 * 86400
    })
    await h.webhook(checkoutCompleted({ customer, subscription: subscription.id, accountId: 'org:o1' }))
    const paid = (await poll(id, owner)).body
    expect(paid.plan).toBe('subscription')
    expect(paid.finished).toBe(true)
  })

  it('keeps the plan step when the trial is refused, and never lets another user or team in', async () => {
    const { h, create, poll, pages } = await setup({ refuseTrial: true })
    const id = (await create({ needs: ['plan'] })).body.id
    expect((await pages.post(id, 'team', { userId: 'u2', orgId: 'o9', name: 'x' })).status).toBe(404)
    expect((await pages.post(id, 'team', { userId: 'u1', orgId: 'o1', name: 'acme' })).body).toEqual({ ok: true, trial: 'unavailable' })
    expect((await pages.post(id, 'team', { userId: 'u1', orgId: 'o2', name: 'other' })).status).toBe(409)
    // A rename of the same team is fine.
    expect((await pages.post(id, 'team', { userId: 'u1', orgId: 'o1', name: 'acme-web' })).status).toBe(200)
    expect((await poll(id)).body.team).toEqual({ orgId: 'o1', name: 'acme-web', created: false })
    const stranger = { authorization: `Bearer ${await h.desktopToken({ sub: 'u2' })}` }
    expect((await poll(id, stranger)).status).toBe(404)
    expect((await h.call('GET', `/v1/cloud-setup/sessions/${id}`)).status).toBe(401)
    expect((await h.call('GET', `/v1/internal/cloud-setup/sessions/${id}?userId=u1`, { headers: { authorization: `Bearer ${CONTROL_TOKEN}` } })).status).toBe(401)
  })

  it('reports a stalled session as timed out and expires it after two hours', async () => {
    const { h, create, poll } = await setup()
    const start = Date.now()
    h.setNow(start)
    const id = (await create({ needs: ['plan'] })).body.id
    h.setNow(start + 16 * 60_000)
    expect((await poll(id)).body.error).toEqual({ kind: 'timed_out' })
    h.setNow(start + 2 * 3600_000 + 1)
    expect((await poll(id)).status).toBe(404)
  })

  it('rate limits session creation per user', async () => {
    const { create } = await setup()
    for (let i = 0; i < 20; i++) {
      expect((await create({ needs: ['plan'] })).status).toBe(201)
    }
    expect((await create({ needs: ['plan'] })).status).toBe(429)
  })

  it('matches control-plane GitHub events without a session id on account and repo', async () => {
    const { h, create, poll, pages } = await setup()
    const id = (await create()).body.id
    await pages.post(id, 'team', { userId: 'u1', orgId: 'o1', name: 'acme' })
    expect((await h.controlPlane('/v1/internal/cloud-setup/github', { accountId: 'org:o1', repo: 'https://github.com/acme/web', state: 'pending' })).body).toEqual({ ok: true, matched: 1 })
    expect((await poll(id)).body.steps.at(-1)).toEqual({ id: 'github', state: 'active', detail: 'requested' })
    expect((await h.controlPlane('/v1/internal/cloud-setup/github', { accountId: 'org:o1', repo: 'https://github.com/acme/web', state: 'done' })).body.matched).toBe(1)
    // A late 'pending' never undoes 'done'.
    expect((await h.controlPlane('/v1/internal/cloud-setup/github', { accountId: 'org:o1', repo: 'https://github.com/acme/web', state: 'pending' })).body.matched).toBe(0)
    expect((await h.controlPlane('/v1/internal/cloud-setup/github', { accountId: 'org:o1', repo: 'x', state: 'done' }, 'wrong-token-0123456789abcdef0123456789')).status).toBe(401)
  })
})

describe('team-first checkout', () => {
  it('refuses a personal-account Checkout with team_required', async () => {
    const h = await createHarness()
    const solo = await h.desktopToken({ sub: 'u3' })
    expect(await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team' }, headers: { authorization: `Bearer ${solo}` } })).toEqual({
      status: 409,
      body: { error: 'team_required' }
    })
    expect(h.stripe.customers.size).toBe(0)
  })

  it('lets the plans dialog join its own setup session only', async () => {
    const h = await createHarness({ MEMBERSHIP_SYNC_TOKEN: SYNC, CLOUD_SETUP_PAGES_URL: 'https://auth.test' })
    const owner = { authorization: `Bearer ${await h.desktopToken({ sub: 'u1', org: 'o1', orgRole: 'owner' })}` }
    const other = { authorization: `Bearer ${await h.desktopToken({ sub: 'u2', org: 'o1', orgRole: 'owner' })}` }
    const id = (await h.call('POST', '/v1/cloud-setup/sessions', { body: { needs: ['plan'] }, headers: owner })).body.id
    expect((await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team', setupSessionId: id }, headers: other })).body).toEqual({
      error: 'setup_session_mismatch'
    })
    const joined = await h.call('POST', '/v1/billing/checkout', { body: { plan: 'team', setupSessionId: id }, headers: owner })
    expect(joined.status).toBe(200)
    const call = h.stripe.calls.find((c) => c.method === 'POST' && c.path === '/v1/checkout/sessions')!
    expect(call.form.get('success_url')).toContain(`/cloud/setup/next?session=${id}`)
  })
})

describe('setup session with the real trial module', () => {
  it('grants the one-time trial to the team setup creates, once', async () => {
    const h = await createHarness({ MEMBERSHIP_SYNC_TOKEN: SYNC, CLOUD_SETUP_PAGES_URL: 'https://auth.test' })
    const sync = { authorization: `Bearer ${SYNC}` }
    const auth = { authorization: `Bearer ${await h.desktopToken({ sub: 'u1', email: 'neil@acme.dev' })}` }
    const offers = await h.call('GET', '/v1/cloud-setup/offers')
    expect(offers.body.trial).toEqual({ includedSeconds: 7200 })
    const id = (await h.call('POST', '/v1/cloud-setup/sessions', { body: { needs: ['plan'] }, headers: auth })).body.id
    const bound = await h.call('POST', `/v1/internal/cloud-setup/sessions/${id}/team`, {
      body: { userId: 'u1', orgId: 'o_new', name: 'acme', created: true, email: 'neil@acme.dev' },
      headers: sync
    })
    expect(bound.body).toEqual({ ok: true, trial: 'granted' })
    const view = (await h.call('GET', `/v1/cloud-setup/sessions/${id}`, { headers: auth })).body
    expect(view.plan).toBe('trial')
    expect(view.trial).toEqual({ includedSeconds: 7200, usedSeconds: 0, exhausted: false })
    expect(view.finished).toBe(true)
    // Same user, second new team: the per-user abuse key refuses it.
    const second = (await h.call('POST', '/v1/cloud-setup/sessions', { body: { needs: ['plan'] }, headers: auth })).body.id
    const again = await h.call('POST', `/v1/internal/cloud-setup/sessions/${second}/team`, {
      body: { userId: 'u1', orgId: 'o_other', name: 'acme-2', created: true, email: 'neil@acme.dev' },
      headers: sync
    })
    expect(again.body).toEqual({ ok: true, trial: 'unavailable' })
  })

  it('grants the trial to the desktop’s active team when setup starts on it (no Checkout)', async () => {
    const h = await createHarness({ MEMBERSHIP_SYNC_TOKEN: SYNC, CLOUD_SETUP_PAGES_URL: 'https://auth.test' })
    const owner = { authorization: `Bearer ${await h.desktopToken({ sub: 'u7', org: 'o_live', orgRole: 'owner', email: 'o@acme.dev' })}` }
    const id = (await h.call('POST', '/v1/cloud-setup/sessions', { body: { needs: ['plan'] }, headers: owner })).body.id
    const view = (await h.call('GET', `/v1/cloud-setup/sessions/${id}`, { headers: owner })).body
    expect(view.plan).toBe('trial')
    expect(view.steps).toEqual([
      { id: 'account', state: 'done' },
      { id: 'team', state: 'done' },
      { id: 'plan', state: 'done', detail: 'trial' }
    ])
    expect(view.finished).toBe(true)
  })
})
