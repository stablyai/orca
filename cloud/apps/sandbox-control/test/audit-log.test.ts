// The team audit log (GET /v1/audit-log): one feed merged from audit_log and secret_events, paged
// and filtered, readable only by a team's owners and admins while the plan includes it, and never
// carrying a secret value or hint. Plus the push route other services record through.
import { describe, expect, it } from 'vitest'
import { AUDIT_CATEGORIES, CSV_HEADER, categoryOf } from '../src/api/audit-log'
import { createHarness } from './harness'

const KEK = Buffer.alloc(32, 7).toString('base64')
const AUTH_TOKEN = 'a'.repeat(40)
const OPERATOR = 'o'.repeat(40)
const BILLING_TOKEN = 'b'.repeat(40)
// Fake values only; none may appear in the log, in any format.
const SECRET_VALUES = ['sk-ant-api03-AUDIT-fake-0000-wxyz', 'audit-env-value-two-9876']

type Event = {
  id: string
  at: number
  category: string
  action: string
  actor: { kind: string; userId: string | null; name: string | null; via: string | null }
  target: { type: string; id: string | null; label: string | null } | null
  detail: Record<string, unknown> | null
}

/** Auth tells the control plane a member has gone. */
async function createRemoval(h: Awaited<ReturnType<typeof createHarness>>, userId: string): Promise<number> {
  h.env.MEMBER_REMOVED_TOKEN = AUTH_TOKEN
  return (await h.call('POST', '/v1/internal/org-members/removed', { bearer: AUTH_TOKEN, body: { accountId: 'org:acme', userId } })).status
}

async function setup(options: { entitled?: boolean } = {}) {
  const h = await createHarness({ SECRETS_KEK: KEK, MEMBER_REMOVED_TOKEN: AUTH_TOKEN, OPERATOR_TOKEN: OPERATOR, CONTROL_PLANE_TOKEN: BILLING_TOKEN, PUBLIC_API_URL: 'https://api.test' })
  h.billing.features = { auditLog: options.entitled ?? true }
  const owner = await h.token('olga', 'acme', 'sandbox', { org_role: 'owner', name: 'Olga Owner' })
  const admin = await h.token('alice', 'acme', 'sandbox', { org_role: 'admin', name: 'Alice Admin' })
  const member = await h.token('bob', 'acme', 'sandbox', { org_role: 'member', name: 'Bob Member' })
  const solo = await h.token('carol')
  const log = (bearer: string, query = '') => h.call('GET', `/v1/audit-log${query ? `?${query}` : ''}`, { bearer })
  const internal = (path: string, body: unknown, bearer = AUTH_TOKEN) => h.call('POST', path, { body, bearer })
  return { h, owner, admin, member, solo, log, internal }
}

/** A key, a setting, two secrets and a removed teammate: one event from every source. */
async function seed(s: Awaited<ReturnType<typeof setup>>) {
  const { h, admin, owner, member } = s
  const key = await h.call('POST', '/v1/api-keys', { bearer: admin, body: { name: 'CI', scopes: ['workspaces:read'] } })
  expect(key.status).toBe(201)
  h.advance(1000)
  expect((await h.call('PUT', '/v1/secrets/org/STRIPE_KEY', { bearer: admin, body: { value: SECRET_VALUES[0] } })).status).toBe(200)
  h.advance(1000)
  expect((await h.call('PUT', '/v1/settings', { bearer: owner, body: { vmCliEnabled: false } })).status).toBe(200)
  h.advance(1000)
  expect((await h.call('PUT', '/v1/secrets/org/STRIPE_KEY', { bearer: owner, body: { value: SECRET_VALUES[1] } })).status).toBe(200)
  h.advance(1000)
  // Bob records his name by calling the API, then is removed by Olga.
  expect((await h.call('GET', '/v1/me', { bearer: member })).status).toBe(200)
  h.advance(1000)
  expect((await s.internal('/v1/internal/org-members/removed', { accountId: 'org:acme', userId: 'bob', actorUserId: 'olga' })).status).toBe(200)
  h.advance(1000)
  return { keyId: key.body.key.id as string, keySecret: key.body.secret as string }
}

describe('merge', () => {
  it('returns every source in one feed, newest first, with who, what, target and when', async () => {
    const s = await setup()
    await seed(s)
    const page = await s.log(s.owner)
    expect(page.status).toBe(200)
    const events: Event[] = page.body.events
    expect(events.map((event) => event.action)).toEqual(['member.removed', 'secret.updated', 'settings.update', 'secret.created', 'api_key.create'])
    expect(events.map((event) => event.category)).toEqual(['members', 'secrets', 'settings', 'secrets', 'api_keys'])
    expect(events.map((event) => event.at)).toEqual([...events.map((event) => event.at)].sort((a, b) => b - a))
    expect(page.body.nextCursor).toBeNull()
    expect(page.body.categories).toEqual([...AUDIT_CATEGORIES])

    const [removed, updated, , created, key] = events as [Event, Event, Event, Event, Event]
    expect(removed.actor).toEqual({ kind: 'person', userId: 'olga', name: 'Olga Owner', via: null })
    expect(removed.target).toEqual({ type: 'member', id: 'bob', label: 'Bob Member' })
    expect(updated.actor).toMatchObject({ kind: 'person', userId: 'olga', name: 'Olga Owner' })
    expect(updated.target).toEqual({ type: 'secret', id: 'STRIPE_KEY', label: 'STRIPE_KEY' })
    expect(updated.detail).toEqual({ scope: 'org' })
    expect(created.actor).toMatchObject({ userId: 'alice', name: 'Alice Admin' })
    expect(key.target).toMatchObject({ type: 'api_key', label: 'CI' })
  })

  it('names a person who has left as a former teammate, and the system when nobody did it', async () => {
    const s = await setup()
    // Bob makes a key while a member (an admin-made one would need admin), then leaves by a directory sync.
    expect((await s.h.call('POST', '/v1/api-keys', { bearer: s.member, body: { name: 'bobs', scopes: ['workspaces:read'] } })).status).toBe(201)
    s.h.advance(1000)
    expect((await s.internal('/v1/internal/org-members/removed', { accountId: 'org:acme', userId: 'bob' })).status).toBe(200)
    const events: Event[] = (await s.log(s.owner)).body.events
    expect(events.map((event) => [event.action, event.actor.kind, event.actor.userId])).toEqual([
      ['member.removed', 'system', null],
      ['api_key.create', 'former_member', 'bob']
    ])
    expect(events[0]!.target).toEqual({ type: 'member', id: 'bob', label: 'Bob Member' })
    expect(events[1]!.actor.name).toBe('Bob Member')
    // Leaving by yourself reads as that, not as a removal.
    s.h.advance(1000)
    expect((await s.internal('/v1/internal/org-members/removed', { accountId: 'org:acme', userId: 'alice', actorUserId: 'alice' })).status).toBe(200)
    expect((await s.log(s.owner)).body.events[0]).toMatchObject({ action: 'member.left', actor: { kind: 'former_member', userId: 'alice' } })
  })

  it('records who changed a role when auth says, and how a person acted through an API key', async () => {
    const s = await setup()
    const { keySecret } = await seed(s)
    expect((await s.internal('/v1/internal/members/role-changed', { accountId: 'org:acme', userId: 'alice', role: 'member', actorUserId: 'olga' }, OPERATOR)).status).toBe(200)
    const role: Event = (await s.log(s.owner)).body.events[0]
    expect(role).toMatchObject({ action: 'member.role_changed', actor: { kind: 'person', userId: 'olga' }, target: { type: 'member', id: 'alice' }, detail: { role: 'member' } })
    const adminKey = await s.h.call('POST', '/v1/api-keys', { bearer: s.owner, body: { name: 'ops', scopes: ['projects:write'] } })
    s.h.advance(1000)
    expect((await s.h.call('POST', '/v1/projects', { bearer: adminKey.body.secret, body: { name: 'web', repo: { url: 'https://github.com/acme/web' } } })).status).toBe(201)
    void keySecret
    expect((await s.log(s.owner)).body.events[0]).toMatchObject({ action: 'project.create', category: 'settings', actor: { kind: 'person', userId: 'olga', via: 'api_key' } })
  })

  it("keeps each team's log to itself", async () => {
    const s = await setup()
    await seed(s)
    const other = await s.h.token('zed', 'globex', 'sandbox', { org_role: 'owner' })
    expect((await s.log(other)).body.events).toEqual([])
    expect((await s.log(other)).body.actors).toEqual([])
  })
})

describe('paging', () => {
  it('walks the merged feed across both sources without a gap or a repeat', async () => {
    const s = await setup()
    await seed(s)
    const all: Event[] = (await s.log(s.owner)).body.events
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const page: { status: number; body: { events: Event[]; nextCursor: string | null; actors?: unknown } } = await s.log(s.owner, `limit=2${cursor ? `&cursor=${cursor}` : ''}`)
      expect(page.status).toBe(200)
      expect(page.body.events.length).toBeLessThanOrEqual(2)
      // The people filter's options come with the first page only.
      expect(page.body.actors !== undefined).toBe(cursor === null)
      seen.push(...page.body.events.map((event) => event.id))
      cursor = page.body.nextCursor
      pages += 1
    } while (cursor)
    expect(pages).toBe(3)
    expect(seen).toEqual(all.map((event) => event.id))
  })

  it('orders events that share a millisecond by id, so a page boundary between them is stable', async () => {
    const s = await setup()
    // No clock advance: a key and a secret in the same millisecond.
    await s.h.call('POST', '/v1/api-keys', { bearer: s.admin, body: { name: 'one', scopes: ['workspaces:read'] } })
    await s.h.call('PUT', '/v1/secrets/org/SAME_MS', { bearer: s.admin, body: { value: SECRET_VALUES[0] } })
    await s.h.call('POST', '/v1/api-keys', { bearer: s.admin, body: { name: 'two', scopes: ['workspaces:read'] } })
    const all: Event[] = (await s.log(s.owner)).body.events
    expect(new Set(all.map((event) => event.at)).size).toBe(1)
    const first = await s.log(s.owner, 'limit=1')
    const second = await s.log(s.owner, `limit=1&cursor=${first.body.nextCursor}`)
    const third = await s.log(s.owner, `limit=1&cursor=${second.body.nextCursor}`)
    expect([first, second, third].map((page) => page.body.events[0].id)).toEqual(all.map((event) => event.id))
    expect(third.body.nextCursor).toBeNull()
  })

  it('clamps the page size and refuses a malformed cursor, category or actor', async () => {
    const s = await setup()
    await seed(s)
    expect((await s.log(s.owner, 'limit=100000')).status).toBe(200)
    expect((await s.log(s.owner, 'limit=0')).body.events).toHaveLength(5)
    for (const query of ['cursor=nope', 'category=everything', 'actor=a%20b', 'format=xml']) {
      const refused = await s.log(s.owner, query)
      expect([query, refused.status, refused.body.error]).toEqual([query, 400, 'invalid_request'])
    }
  })
})

describe('filtering', () => {
  it('by category, including across sources', async () => {
    const s = await setup()
    await seed(s)
    const actions = async (query: string) => ((await s.log(s.owner, query)).body.events as Event[]).map((event) => event.action)
    expect(await actions('category=secrets')).toEqual(['secret.updated', 'secret.created'])
    expect(await actions('category=members')).toEqual(['member.removed'])
    expect(await actions('category=api_keys')).toEqual(['api_key.create'])
    expect(await actions('category=settings')).toEqual(['settings.update'])
    expect(await actions('category=billing')).toEqual([])
    expect(await actions('category=other')).toEqual([])
    // Paging holds inside a filter.
    const first = await s.log(s.owner, 'category=secrets&limit=1')
    expect(first.body.events[0].action).toBe('secret.updated')
    expect(((await s.log(s.owner, `category=secrets&limit=1&cursor=${first.body.nextCursor}`)).body.events as Event[]).map((event) => event.action)).toEqual(['secret.created'])
  })

  it('every action the control plane records has a category', () => {
    const recorded = ['api_key.create', 'workspace_token.issue', 'settings.update', 'project.delete', 'workspace.share_create', 'sandbox.ssh_key_added', 'routine.run.start', 'mcp.authorize', 'member.role_synced', 'secret.deleted', 'mfa.policy.enabled', 'sso.went_live', 'scim.user_provisioned', 'billing.plan_changed']
    expect(recorded.map(categoryOf)).toEqual(['api_keys', 'api_keys', 'settings', 'settings', 'workspaces', 'workspaces', 'routines', 'apps', 'members', 'secrets', 'security', 'security', 'security', 'billing'])
    expect(categoryOf('something.new')).toBe('other')
  })

  it('by actor: a person, or the system; what happened TO someone is not what they did', async () => {
    const s = await setup()
    await seed(s)
    expect((await s.internal('/v1/internal/org-members/removed', { accountId: 'org:acme', userId: 'dave' })).status).toBe(200)
    const actions = async (query: string) => ((await s.log(s.owner, query)).body.events as Event[]).map((event) => event.action)
    expect(await actions('actor=alice')).toEqual(['secret.created', 'api_key.create'])
    expect(await actions('actor=olga')).toEqual(['member.removed', 'secret.updated', 'settings.update'])
    expect(await actions('actor=system')).toEqual(['member.removed'])
    // Dave was removed by the system and did nothing himself.
    expect(await actions('actor=dave')).toEqual([])
    expect(await actions('actor=olga&category=secrets')).toEqual(['secret.updated'])
    const actors = (await s.log(s.owner)).body.actors as Array<{ userId: string; name: string | null; kind: string }>
    expect(actors.map((actor) => [actor.userId, actor.name, actor.kind])).toEqual([
      ['alice', 'Alice Admin', 'person'],
      ['olga', 'Olga Owner', 'person']
    ])
  })
})

describe('who may read', () => {
  it('owners and admins of the team; never a member, a personal account or a signed-out caller', async () => {
    const s = await setup()
    await seed(s)
    expect((await s.log(s.owner)).status).toBe(200)
    const admin = await s.h.token('ada', 'acme', 'sandbox', { org_role: 'admin' })
    expect((await s.log(admin)).status).toBe(200)
    const member = await s.h.token('mia', 'acme', 'sandbox', { org_role: 'member' })
    expect((await s.log(member)).body).toEqual({ error: 'insufficient_scope', reason: 'audit:read' })
    expect((await s.log(s.solo)).body).toEqual({ error: 'forbidden', reason: 'team_required' })
    expect((await s.h.call('GET', '/v1/audit-log', { bearer: 'not-a-token' })).status).toBe(401)
  })

  it('an API key reads it only with audit:read, and never past its creator being demoted', async () => {
    const s = await setup()
    await seed(s)
    const reader = await s.h.call('POST', '/v1/api-keys', { bearer: s.owner, body: { name: 'siem', scopes: ['audit:read'] } })
    const other = await s.h.call('POST', '/v1/api-keys', { bearer: s.owner, body: { name: 'ci', scopes: ['workspaces:read'] } })
    expect((await s.log(reader.body.secret)).status).toBe(200)
    expect((await s.log(other.body.secret)).body).toEqual({ error: 'insufficient_scope', reason: 'audit:read' })
    expect((await s.internal('/v1/internal/members/role-changed', { accountId: 'org:acme', userId: 'olga', role: 'member' }, OPERATOR)).status).toBe(200)
    expect((await s.log(reader.body.secret)).status).toBe(403)
  })
})

describe('the plan gate', () => {
  it('refuses a team without the audit_log entitlement, for the list and the export, and says why', async () => {
    const s = await setup({ entitled: false })
    await seed(s)
    for (const query of ['', 'format=csv', 'category=secrets']) {
      const refused = await s.log(s.owner, query)
      expect(refused.status).toBe(403)
      expect(refused.body).toEqual({ error: 'entitlement_denied', reason: 'audit_log' })
      expect(JSON.stringify(refused.body)).not.toContain('STRIPE_KEY')
    }
  })

  it('checks the role before the plan, so a member learns nothing about the plan', async () => {
    const s = await setup({ entitled: false })
    expect((await s.log(s.member)).body).toEqual({ error: 'insufficient_scope', reason: 'audit:read' })
  })

  it('keeps recording without the entitlement, so upgrading shows the history', async () => {
    const s = await setup({ entitled: false })
    await seed(s)
    expect((await s.log(s.owner)).status).toBe(403)
    s.h.billing.features = { auditLog: true }
    expect(((await s.log(s.owner)).body.events as Event[]).map((event) => event.action)).toEqual(['member.removed', 'secret.updated', 'settings.update', 'secret.created', 'api_key.create'])
  })

  it('fails closed when billing is down: 503, never an open log and never "not on the plan"', async () => {
    const s = await setup()
    await seed(s)
    s.h.billing.down = true
    const refused = await s.log(s.owner)
    expect(refused.status).toBe(503)
    expect(refused.body).toEqual({ error: 'billing_unavailable' })
  })

  it("asks billing about the caller's own team", async () => {
    const s = await setup()
    const asked: string[] = []
    s.h.deps.entitlements!.features = async (accountId) => {
      asked.push(accountId)
      return { auditLog: accountId === 'org:acme' }
    }
    expect((await s.log(s.owner)).status).toBe(200)
    const other = await s.h.token('zed', 'globex', 'sandbox', { org_role: 'owner' })
    expect((await s.log(other)).status).toBe(403)
    expect(asked).toEqual(['org:acme', 'org:globex'])
  })
})

describe('secrets never leak', () => {
  it('no value, hint or last four in the JSON, the CSV or the stored rows', async () => {
    const s = await setup()
    await seed(s)
    // An audit entry that (wrongly) carried credential-looking fields is still not served.
    s.h.raw
      .prepare(`INSERT INTO audit_log (id, account_id, actor_type, actor_id, user_id, action, target_type, target_id, detail, created_at) VALUES (?, ?, 'user', 'olga', 'olga', 'settings.update', 'account', 'org:acme', ?, ?)`)
      .run('aud_leaky', 'org:acme', JSON.stringify({ name: 'safe', apiToken: 'tok_should_not_show', secretValue: 'val_should_not_show', hint: 'wxyz', password: 'pw_should_not_show' }), s.h.now())
    const json = await s.log(s.owner)
    const csv = await (await s.h.send(new Request('https://sandbox.test/v1/audit-log?format=csv', { headers: { authorization: `Bearer ${s.owner}` } }))).text()
    const stored = JSON.stringify(s.h.raw.prepare('SELECT * FROM secret_events').all())
    for (const text of [JSON.stringify(json.body), csv, stored]) {
      for (const value of SECRET_VALUES) {
        expect(text).not.toContain(value)
        expect(text).not.toContain(value.slice(-4))
      }
      expect(text).not.toMatch(/should_not_show/)
    }
    const leaky = (json.body.events as Event[]).find((event) => event.id === 'aud_leaky')!
    expect(leaky.detail).toEqual({ name: 'safe' })
    // The names are there: that is the point of the log.
    expect(JSON.stringify(json.body)).toContain('STRIPE_KEY')
  })

  it("a member's personal secrets never appear in the team's log", async () => {
    const s = await setup()
    expect((await s.h.call('PUT', '/v1/secrets/personal/MY_OWN', { bearer: s.admin, body: { value: SECRET_VALUES[0] } })).status).toBe(200)
    expect(JSON.stringify((await s.log(s.owner)).body)).not.toContain('MY_OWN')
  })
})

describe('CSV export', () => {
  it('exports the filtered log with a header, quoting and formula-safe cells', async () => {
    const s = await setup()
    await seed(s)
    await s.h.call('POST', '/v1/api-keys', { bearer: s.owner, body: { name: '=HYPERLINK("http://evil","x"), "quoted"', scopes: ['workspaces:read'] } })
    const response = await s.h.send(new Request('https://sandbox.test/v1/audit-log?format=csv&category=api_keys', { headers: { authorization: `Bearer ${s.owner}` } }))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="orca-audit-log.csv"')
    expect(response.headers.get('x-orca-audit-truncated')).toBe('false')
    const lines = (await response.text()).trimEnd().split('\r\n')
    expect(lines[0]).toBe(CSV_HEADER.join(','))
    expect(lines).toHaveLength(3)
    expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z,api_keys,api_key\.create,person,Olga Owner,olga,,api_key,key_[A-Za-z0-9]+,/)
    // The label starts with "=": quoted as text, with its quotes doubled.
    expect(lines[1]).toContain(`"'=HYPERLINK(""http://evil"",""x""), ""quoted"""`)
    expect(lines[2]).toContain(',Alice Admin,alice,')
  })
})

describe('events from other services (POST /v1/internal/audit-events)', () => {
  const invite = { eventId: 'evt_invite_0001', action: 'member.invited', actorUserId: 'olga', target: { type: 'invite', label: 'new@acme.dev' }, detail: { role: 'member' } }

  it('appends them to the same log, once, with their actor, target and category', async () => {
    const s = await setup()
    await s.h.call('GET', '/v1/me', { bearer: s.owner })
    const body = {
      accountId: 'org:acme',
      events: [invite, { eventId: 'evt_mfa_0001', action: 'mfa.policy.enabled', actorUserId: 'olga', target: { type: 'policy' }, detail: { grace: 7, pendingMembers: 3 } }, { eventId: 'evt_scim_0001', action: 'scim.user_provisioned', target: { type: 'member', id: 'erin' } }]
    }
    expect((await s.internal('/v1/internal/audit-events', body)).body).toEqual({ recorded: 3, duplicates: 0 })
    // A retry records nothing twice.
    expect((await s.internal('/v1/internal/audit-events', body)).body).toEqual({ recorded: 0, duplicates: 3 })
    const events: Event[] = (await s.log(s.owner)).body.events
    expect(events).toHaveLength(3)
    const byAction = Object.fromEntries(events.map((event) => [event.action, event]))
    expect(byAction['member.invited']).toMatchObject({ category: 'members', actor: { kind: 'person', userId: 'olga', name: 'Olga Owner' }, target: { type: 'invite', id: null, label: 'new@acme.dev' }, detail: { role: 'member' } })
    expect(byAction['mfa.policy.enabled']).toMatchObject({ category: 'security', target: { type: 'policy' }, detail: { grace: 7, pendingMembers: 3 } })
    expect(byAction['scim.user_provisioned']).toMatchObject({ category: 'security', actor: { kind: 'system', userId: null }, target: { type: 'member', id: 'erin' } })
  })

  it("accepts auth's token or the operator's, and nothing else", async () => {
    const s = await setup()
    const body = { accountId: 'org:acme', events: [invite] }
    expect((await s.internal('/v1/internal/audit-events', body, OPERATOR)).status).toBe(200)
    expect((await s.internal('/v1/internal/audit-events', body, 'x'.repeat(40))).status).toBe(404)
    expect((await s.internal('/v1/internal/audit-events', body, s.owner)).status).toBe(404)
    // Auth's token still opens none of the operator routes.
    expect((await s.h.call('GET', '/v1/internal/status', { bearer: AUTH_TOKEN })).status).toBe(404)
  })

  it("billing's bearer writes billing events and nothing else; auth's writes none of billing's", async () => {
    const s = await setup()
    const plan = { eventId: 'billing_0000000001', action: 'billing.seats_changed', target: { type: 'plan' }, detail: { seats: 5, previousSeats: 2 } }
    const overage = { eventId: 'billing_0000000002', action: 'billing.overage_enabled', actorUserId: 'olga', target: { type: 'plan' } }
    await s.h.call('GET', '/v1/me', { bearer: s.owner })
    expect((await s.internal('/v1/internal/audit-events', { accountId: 'org:acme', events: [plan, overage] }, BILLING_TOKEN)).body).toEqual({ recorded: 2, duplicates: 0 })
    const events: Event[] = (await s.log(s.owner, 'category=billing')).body.events
    expect(events.map((event) => [event.action, event.actor.kind, event.actor.name, event.target?.type, event.detail])).toEqual(
      expect.arrayContaining([
        ['billing.seats_changed', 'system', null, 'plan', { seats: 5, previousSeats: 2 }],
        ['billing.overage_enabled', 'person', 'Olga Owner', 'plan', null]
      ])
    )
    expect(events).toHaveLength(2)
    // One sender cannot write another's events.
    const forged = await s.internal('/v1/internal/audit-events', { accountId: 'org:acme', events: [invite] }, BILLING_TOKEN)
    expect([forged.status, forged.body.reason]).toEqual([400, 'action_not_allowed_for_sender:member.invited'])
    const crossed = await s.internal('/v1/internal/audit-events', { accountId: 'org:acme', events: [{ ...plan, eventId: 'billing_0000000003' }] })
    expect([crossed.status, crossed.body.reason]).toEqual([400, 'action_not_allowed_for_sender:billing.seats_changed'])
    // The operator may write either.
    expect((await s.internal('/v1/internal/audit-events', { accountId: 'org:acme', events: [{ ...plan, eventId: 'billing_0000000004' }, invite] }, OPERATOR)).status).toBe(200)
    // Billing's bearer opens nothing else under /v1/internal.
    expect((await s.h.call('GET', '/v1/internal/status', { bearer: BILLING_TOKEN })).status).toBe(404)
    expect((await s.internal('/v1/internal/org-members/removed', { accountId: 'org:acme', userId: 'bob' }, BILLING_TOKEN)).status).toBe(404)
    expect((await s.internal('/v1/internal/members/role-changed', { accountId: 'org:acme', userId: 'bob', role: 'owner' }, BILLING_TOKEN)).status).toBe(404)
  })

  it('accepts the team and join events auth sends', async () => {
    const s = await setup()
    const events = [
      { eventId: 'member_0000000001', action: 'member.joined', actorUserId: 'erin', target: { type: 'member', id: 'erin' }, detail: { source: 'sign-in', role: 'member' } },
      { eventId: 'member_0000000002', action: 'member.invite_revoked', actorUserId: 'olga', target: { type: 'invite', label: 'x@acme.dev' } },
      { eventId: 'team_0000000001', action: 'team.renamed', actorUserId: 'olga', target: { type: 'team', label: 'Acme Labs' }, detail: { via: 'cloud-setup', previousName: 'Acme' } },
      { eventId: 'team_0000000002', action: 'team.deleted', actorUserId: 'olga', target: { type: 'team', label: 'Acme Labs' }, detail: { members: 3 } }
    ]
    expect((await s.internal('/v1/internal/audit-events', { accountId: 'org:acme', events })).body).toEqual({ recorded: 4, duplicates: 0 })
    const members: Event[] = (await s.log(s.owner, 'category=members')).body.events
    expect(members.map((event) => event.action).sort()).toEqual(['member.invite_revoked', 'member.joined', 'team.deleted', 'team.renamed'])
    expect(members.find((event) => event.action === 'team.renamed')).toMatchObject({ target: { type: 'team', label: 'Acme Labs' }, detail: { previousName: 'Acme' } })
  })

  it('refuses anything that could pass for another kind of change, hold a credential, or post-date the log', async () => {
    const s = await setup()
    const post = (event: Record<string, unknown>, accountId = 'org:acme') => s.internal('/v1/internal/audit-events', { accountId, events: [{ ...invite, ...event }] })
    for (const action of ['api_key.create', 'secret.deleted', 'workspace.destroy', 'settings.update', 'member', 'MEMBER.invited', 'member.removed', 'member.role_changed']) {
      expect([action, (await post({ action })).status]).toEqual([action, 400])
    }
    expect((await post({ detail: { resetCode: '123456' } })).body).toEqual({ error: 'invalid_request', reason: 'detail_key_not_allowed:resetCode' })
    expect((await post({ detail: { scimToken: 'x' } })).status).toBe(400)
    expect((await post({ detail: { nested: { a: 1 } } })).status).toBe(400)
    expect((await post({ unknown: true })).status).toBe(400)
    expect((await post({}, 'user:alice')).status).toBe(400)
    expect((await s.log(s.owner)).body.events).toEqual([])
    // A sender's fast clock can't put an event in the future.
    expect((await post({ at: s.h.now() + 86_400_000 })).status).toBe(200)
    expect((await s.log(s.owner)).body.events[0].at).toBe(s.h.now())
  })
})

describe('the older GET /v1/audit', () => {
  it('is behind the same plan gate for a team, so it is no way around it; a personal account keeps its own', async () => {
    const s = await setup({ entitled: false })
    await seed(s)
    expect((await s.h.call('GET', '/v1/audit', { bearer: s.owner })).body).toEqual({ error: 'entitlement_denied', reason: 'audit_log' })
    const key = await s.h.call('POST', '/v1/api-keys', { bearer: s.owner, body: { name: 'siem', scopes: ['audit:read'] } })
    expect((await s.h.call('GET', '/v1/audit', { bearer: key.body.secret })).status).toBe(403)
    s.h.billing.features = { auditLog: true }
    expect((await s.h.call('GET', '/v1/audit', { bearer: key.body.secret })).status).toBe(200)
    // No team, no team log: a personal account still reads its own API activity on any plan.
    s.h.billing.features = { auditLog: false }
    await s.h.call('POST', '/v1/api-keys', { bearer: s.solo, body: { name: 'mine', scopes: ['workspaces:read'] } })
    const own = await s.h.call('GET', '/v1/audit', { bearer: s.solo })
    expect(own.status).toBe(200)
    expect(own.body.entries.map((entry: { action: string }) => entry.action)).toEqual(['api_key.create'])
    // But never the unified route.
    expect((await s.log(s.solo)).body).toEqual({ error: 'forbidden', reason: 'team_required' })
  })
})

describe('what is recorded', () => {
  it('sharing a workspace with the team and making it private again, by whom, with from and to (EP-3)', async () => {
    const h = await createHarness()
    h.billing.features = { auditLog: true }
    const owner = await h.token('olga', 'acme', 'sandbox', { org_role: 'member', name: 'Olga Owner' })
    const admin = await h.token('ada', 'acme', 'sandbox', { org_role: 'admin', name: 'Ada Admin' })
    const created = await h.call('POST', '/v1/sandboxes', { bearer: owner, body: { workspaceId: 'ws-1', machineSize: 'standard' } })
    const id: string = created.body.sandbox.id
    const patch = (bearer: string, body: unknown) => h.call('PATCH', `/v1/team/workspaces/${id}`, { bearer, body })
    h.advance(1000)
    expect((await patch(owner, { title: 'checkout-redesign', visibility: 'team' })).status).toBe(200)
    h.advance(1000)
    // The same value again, and an edit that does not touch visibility: nothing to record.
    expect((await patch(owner, { visibility: 'team' })).status).toBe(200)
    expect((await patch(owner, { title: 'checkout' })).status).toBe(200)
    h.advance(1000)
    // An admin makes it private: they are the actor, not the workspace's owner.
    expect((await patch(admin, { visibility: 'private' })).status).toBe(200)
    const events: Event[] = (await h.call('GET', '/v1/audit-log?category=workspaces', { bearer: admin })).body.events
    expect(events.map((event) => [event.action, event.actor.userId, event.target, event.detail])).toEqual([
      ['workspace.made_private', 'ada', { type: 'workspace', id, label: 'checkout' }, { from: 'team', to: 'private' }],
      ['workspace.shared_with_team', 'olga', { type: 'workspace', id, label: 'checkout' }, { from: 'private', to: 'team' }],
      ['workspace.create', 'olga', { type: 'workspace', id, label: 'checkout' }, { origin: 'desktop', visibility: 'private' }]
    ])
    // A refused change records nothing: a plain member cannot change someone else's workspace.
    const other = await h.token('bob', 'acme', 'sandbox', { org_role: 'member' })
    expect((await patch(other, { visibility: 'team' })).status).not.toBe(200)
    expect(((await h.call('GET', '/v1/audit-log?category=workspaces', { bearer: admin })).body.events as Event[]).length).toBe(3)
  })

  it('handing a workspace to a new owner is recorded with both people', async () => {
    const h = await createHarness()
    h.billing.features = { auditLog: true }
    const admin = await h.token('ada', 'acme', 'sandbox', { org_role: 'admin', name: 'Ada Admin' })
    const created = await h.call('POST', '/v1/sandboxes', { bearer: admin, body: { workspaceId: 'ws-1', machineSize: 'standard' } })
    const id: string = created.body.sandbox.id
    h.advance(1000)
    expect((await h.call('PATCH', `/v1/team/workspaces/${id}`, { bearer: admin, body: { ownerUserId: 'bob' } })).status).toBe(200)
    const changed = ((await h.call('GET', '/v1/audit-log?category=workspaces', { bearer: admin })).body.events as Event[]).find((event) => event.action === 'workspace.owner_changed')
    expect(changed).toMatchObject({ action: 'workspace.owner_changed', actor: { userId: 'ada' }, target: { type: 'workspace', id }, detail: { fromUserId: 'ada', toUserId: 'bob' } })
    // Nobody can name Bob yet (he has never called the API): no name, not marked as gone.
    expect(changed!.detail).toEqual({ fromUserId: 'ada', toUserId: 'bob' })
    // Once he has, the same row names him; once he has left, it says so.
    const bob = await h.token('bob', 'acme', 'sandbox', { org_role: 'member', name: 'Bob Member' })
    expect((await h.call('GET', '/v1/me', { bearer: bob })).status).toBe(200)
    const read = async (): Promise<Event> => ((await h.call('GET', '/v1/audit-log?category=workspaces', { bearer: admin })).body.events as Event[]).find((event) => event.action === 'workspace.owner_changed')!
    expect((await read()).detail).toEqual({ fromUserId: 'ada', toUserId: 'bob', toUserName: 'Bob Member' })
    const removed = await createRemoval(h, 'bob')
    expect(removed).toBe(200)
    expect((await read()).detail).toEqual({ fromUserId: 'ada', toUserId: 'bob', toUserName: 'Bob Member', toUserFormer: true })
  })

  it('desktop workspace changes: create, share, stop sharing, archive, unarchive and delete, each by the person who did it', async () => {
    const h = await createHarness({ SHARE_LINK_SECRET: 's'.repeat(40), SHARE_HOST_SUFFIX: 'share.test' })
    h.billing.features = { auditLog: true }
    const owner = await h.token('olga', 'acme', 'sandbox', { org_role: 'owner', name: 'Olga Owner' })
    const created = await h.call('POST', '/v1/sandboxes', { bearer: owner, body: { workspaceId: 'ws-1', machineSize: 'standard' } })
    expect(created.status).toBe(200)
    const id: string = created.body.sandbox.id
    h.advance(1000)
    const share = await h.call('POST', `/v1/sandboxes/${id}/shares`, { bearer: owner, body: { port: 3000, audience: 'team', expiresIn: '1h' } })
    expect(share.status).toBe(200)
    h.advance(1000)
    expect((await h.call('DELETE', `/v1/sandboxes/${id}/shares/${share.body.share.id}`, { bearer: owner })).status).toBe(200)
    h.advance(1000)
    expect((await h.call('POST', `/v1/sandboxes/${id}/archive`, { bearer: owner, body: {} })).status).toBe(200)
    h.advance(1000)
    expect((await h.call('POST', `/v1/sandboxes/${id}/unarchive`, { bearer: owner })).status).toBe(200)
    h.advance(1000)
    expect((await h.call('DELETE', `/v1/sandboxes/${id}`, { bearer: owner })).status).toBe(200)
    const events: Event[] = (await h.call('GET', '/v1/audit-log?category=workspaces', { bearer: owner })).body.events
    expect(events.map((event) => event.action)).toEqual(['workspace.destroy', 'workspace.unarchive', 'workspace.archive', 'workspace.share_revoke', 'workspace.share_create', 'workspace.create'])
    expect(events.every((event) => event.actor.userId === 'olga' && event.actor.kind === 'person' && event.target?.type === 'workspace' && event.target.id === id)).toBe(true)
    // The share link itself (a bearer URL) is never in the log.
    expect(JSON.stringify(events)).not.toMatch(/https?:\/\/|share\.test/)
    expect(events.find((event) => event.action === 'workspace.share_create')!.detail).toEqual({ shareId: share.body.share.id, port: 3000, audience: 'team', expiresIn: '1h' })
  })

  it('audit entries the old GET /v1/audit serves are the same rows, so nothing is lost for API users', async () => {
    const s = await setup()
    await seed(s)
    const old = await s.h.call('GET', '/v1/audit', { bearer: s.owner })
    const unified: Event[] = (await s.log(s.owner)).body.events
    expect(old.body.entries.map((entry: { id: string }) => entry.id)).toEqual(unified.filter((event) => !event.id.startsWith('sev_')).map((event) => event.id))
  })
})
