// SEC-4: every create, update and delete of a cloud secret leaves an activity record (who, when, scope,
// NAME; never the value or hint), team owners/admins read the team's, each user reads their own.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTIVITY_WINDOW_MS } from '../src/secret-events'
import { createHarness } from './harness'

const KEK = Buffer.alloc(32, 7).toString('base64')
// Fake values only; none may appear in an activity record, a response or a log line.
const VALUES = ['sk-ant-api03-ACTIVITY-fake-0000-aaaa', 'activity-env-value-1', 'activity-env-value-2-longer-one']

let logs: string[] = []
beforeEach(() => {
  logs = []
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
    })
  }
})
afterEach(() => {
  for (const value of VALUES) {
    expect(logs.join('\n')).not.toContain(value)
  }
  vi.restoreAllMocks()
})

async function setup() {
  const h = await createHarness({ SECRETS_KEK: KEK })
  const admin = await h.token('alice', 'acme', 'sandbox', { org_role: 'admin', name: 'Alice Admin' })
  const owner = await h.token('olga', 'acme', 'sandbox', { org_role: 'owner' })
  const member = await h.token('bob', 'acme', 'sandbox', { org_role: 'member' })
  const solo = await h.token('carol')
  const put = (scope: string, name: string, value: string, bearer: string, repo?: string) =>
    h.call('PUT', `/v1/secrets/${scope}/${name}${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`, { body: { value }, bearer })
  const del = (scope: string, name: string, bearer: string, repo?: string) =>
    h.call('DELETE', `/v1/secrets/${scope}/${name}${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`, { bearer })
  const activity = (bearer: string, query = 'view=team') => h.call('GET', `/v1/secrets/activity?${query}`, { bearer })
  return { h, admin, owner, member, solo, put, del, activity }
}

describe('secret activity records', () => {
  it('records create, update and delete with who, when, scope and name; never a value or hint', async () => {
    const { h, admin, put, del, activity } = await setup()
    expect((await put('org', 'ANTHROPIC_API_KEY', VALUES[0]!, admin)).status).toBe(200)
    h.advance(1_000)
    expect((await put('org', 'ANTHROPIC_API_KEY', VALUES[1]!, admin)).status).toBe(200)
    h.advance(1_000)
    expect((await put('repo', 'DATABASE_URL', VALUES[2]!, admin, 'acme/web')).status).toBe(200)
    h.advance(1_000)
    expect((await del('org', 'ANTHROPIC_API_KEY', admin)).status).toBe(200)

    const res = await activity(admin)
    expect(res.status).toBe(200)
    expect(res.body.nextCursor).toBeNull()
    expect(res.body.events.map((e: any) => [e.action, e.scope, e.name])).toEqual([
      ['deleted', 'org', 'ANTHROPIC_API_KEY'],
      ['created', 'repo', 'DATABASE_URL'],
      ['updated', 'org', 'ANTHROPIC_API_KEY'],
      ['created', 'org', 'ANTHROPIC_API_KEY']
    ])
    expect(res.body.events[1]).toMatchObject({ repo: 'github.com/acme/web' })
    expect(res.body.events[0]).toMatchObject({ actor: { userId: 'alice', name: 'Alice Admin' }, orgId: 'acme', at: h.now() })
    // Nothing in the table or the response could carry a value or the last-4 hint.
    const stored = JSON.stringify(h.raw.prepare('SELECT * FROM secret_events').all())
    for (const text of [stored, JSON.stringify(res.body)]) {
      for (const value of VALUES) {
        expect(text).not.toContain(value)
        expect(text).not.toContain(value.slice(-4))
      }
      expect(text).not.toMatch(/hint|ciphertext|wrapped/)
    }
  })

  it('records batch writes and deletes, and nothing for a failed write or a delete of nothing', async () => {
    const { h, admin, put, del, activity } = await setup()
    const batch = await h.call('POST', '/v1/secrets/org/batch', {
      bearer: admin,
      body: { set: { A_ONE: VALUES[1], PATH: 'x' }, delete: ['NOT_THERE'] }
    })
    expect(batch.body.errors).toHaveLength(1)
    expect((await put('org', 'lower_case', 'x', admin)).status).toBe(400)
    expect((await del('org', 'MISSING', admin)).status).toBe(404)
    h.advance(1)
    await h.call('POST', '/v1/secrets/org/batch', { bearer: admin, body: { delete: ['A_ONE'] } })
    const events = (await activity(admin)).body.events
    expect(events.map((e: any) => `${e.action}:${e.name}`)).toEqual(['deleted:A_ONE', 'created:A_ONE'])
  })

  it('a refused write (member on a team secret) leaves no record', async () => {
    const { member, admin, put, activity } = await setup()
    expect((await put('org', 'TEAM_VAR', VALUES[1]!, member)).status).toBe(403)
    expect((await activity(admin)).body.events).toEqual([])
  })
})

describe('who can read secret activity', () => {
  it('team activity: owners and admins only; members and personal accounts are refused', async () => {
    const { admin, owner, member, solo, put, activity } = await setup()
    await put('org', 'TEAM_VAR', VALUES[1]!, admin)
    expect((await activity(owner)).body.events).toHaveLength(1)
    const refused = await activity(member)
    expect(refused.status).toBe(403)
    expect(refused.body).toMatchObject({ reason: 'org_admin_required' })
    expect((await activity(solo)).body).toMatchObject({ reason: 'no_org' })
  })

  it('personal changes stay with the user: not in the team log, not in another user’s', async () => {
    const { h, admin, member, put, activity } = await setup()
    await put('personal', 'MY_TOKEN', VALUES[1]!, member)
    expect((await activity(admin)).body.events).toEqual([])
    expect((await activity(admin, 'view=personal')).body.events).toEqual([])
    const mine = (await activity(member, 'view=personal')).body.events
    expect(mine).toMatchObject([{ action: 'created', scope: 'personal', name: 'MY_TOKEN', orgId: 'acme' }])
    // The same user's personal log reads the same with a personal-account token.
    const bobSolo = await h.token('bob')
    expect((await activity(bobSolo, 'view=personal')).body.events).toHaveLength(1)
  })

  it('a personal account sees its own repository secret changes in its personal log', async () => {
    const { solo, put, activity } = await setup()
    await put('repo', 'DATABASE_URL', VALUES[1]!, solo, 'carol/app')
    expect((await activity(solo, 'view=personal')).body.events).toMatchObject([{ scope: 'repo', name: 'DATABASE_URL' }])
  })

  it('another team never sees this team’s activity', async () => {
    const { h, admin, put } = await setup()
    await put('org', 'TEAM_VAR', VALUES[1]!, admin)
    const otherAdmin = await h.token('dave', 'globex', 'sandbox', { org_role: 'owner' })
    expect((await h.call('GET', '/v1/secrets/activity?view=team', { bearer: otherAdmin })).body.events).toEqual([])
  })

  it('rejects an unknown view', async () => {
    const { admin, activity } = await setup()
    expect((await activity(admin, 'view=all')).status).toBe(400)
  })
})

describe('activity window and pagination', () => {
  it('shows the last 90 days only', async () => {
    const { h, admin, put, activity } = await setup()
    await put('org', 'OLD_VAR', VALUES[1]!, admin)
    h.advance(ACTIVITY_WINDOW_MS - 1_000)
    // Tokens live 5 minutes: mint new ones as the clock jumps.
    const later = await h.token('alice', 'acme', 'sandbox', { org_role: 'admin' })
    await put('org', 'NEW_VAR', VALUES[1]!, later)
    expect((await activity(later)).body.events.map((e: any) => e.name)).toEqual(['NEW_VAR', 'OLD_VAR'])
    h.advance(2_000)
    expect((await activity(later)).body.events.map((e: any) => e.name)).toEqual(['NEW_VAR'])
  })

  it('pages newest first with a cursor, including many events in the same millisecond', async () => {
    const { h, admin, activity } = await setup()
    const set = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`VAR_${i}`, `v${i}`]))
    await h.call('POST', '/v1/secrets/org/batch', { bearer: admin, body: { set } })
    h.advance(1)
    await h.call('POST', '/v1/secrets/org/batch', { bearer: admin, body: { delete: ['VAR_0'] } })
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const query: string = `view=team&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const page = (await activity(admin, query)).body
      expect(page.events.length).toBeLessThanOrEqual(3)
      seen.push(...page.events.map((e: any) => e.id))
      cursor = page.nextCursor
      pages++
    } while (cursor && pages < 10)
    expect(pages).toBe(3)
    expect(new Set(seen).size).toBe(8)
    expect((await activity(admin, 'view=team&limit=100')).body.events.map((e: any) => e.id)).toEqual(seen)
  })

  it('ignores a malformed cursor or limit rather than failing', async () => {
    const { admin, put, activity } = await setup()
    await put('org', 'TEAM_VAR', VALUES[1]!, admin)
    const res = await activity(admin, 'view=team&cursor=%27%20OR%201%3D1&limit=-5')
    expect(res.status).toBe(200)
    expect(res.body.events).toHaveLength(1)
  })
})

describe('team delete', () => {
  it('purges the team’s activity with its secrets', async () => {
    const { h, admin, put } = await setup()
    await put('org', 'TEAM_VAR', VALUES[1]!, admin)
    const { purgeTeamSecrets } = await import('../src/team-delete')
    await purgeTeamSecrets(h.env.SANDBOX_DB, 'org:acme')
    expect(h.raw.prepare("SELECT COUNT(*) AS n FROM secret_events WHERE account_id = 'org:acme'").get()).toEqual({ n: 0 })
  })
})
