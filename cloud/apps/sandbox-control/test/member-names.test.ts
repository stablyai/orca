// EP-3c: auth sends display names for a team's members (POST /v1/internal/member-names), so the
// audit log and its CSV export name people who have never used Orca Cloud in the team. The names
// are labels: they never decide who may do or see anything.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createHarness } from './harness'

const AUTH_TOKEN = 'a'.repeat(40)
const OPERATOR = 'o'.repeat(40)
const BILLING_TOKEN = 'b'.repeat(40)

async function setup() {
  const h = await createHarness({ MEMBER_REMOVED_TOKEN: AUTH_TOKEN, OPERATOR_TOKEN: OPERATOR, CONTROL_PLANE_TOKEN: BILLING_TOKEN, PUBLIC_API_URL: 'https://api.test' })
  h.billing.features = { auditLog: true }
  const admin = await h.token('ada', 'acme', 'sandbox', { org_role: 'admin', name: 'Ada Admin' })
  const names = (body: unknown, bearer = AUTH_TOKEN) => h.call('POST', '/v1/internal/member-names', { body, bearer })
  const stored = () => h.raw.prepare('SELECT account_id, user_id, name FROM member_names ORDER BY user_id').all() as Array<{ account_id: string; user_id: string; name: string }>
  return { h, admin, names, stored }
}

describe('names from auth', () => {
  it('name a new owner who has never used Orca Cloud, in the log and in the CSV', async () => {
    const { h, admin, names } = await setup()
    const created = await h.call('POST', '/v1/sandboxes', { bearer: admin, body: { workspaceId: 'ws-1', machineSize: 'standard' } })
    const id: string = created.body.sandbox.id
    h.advance(1000)
    expect((await h.call('PATCH', `/v1/team/workspaces/${id}`, { bearer: admin, body: { title: 'endpass-own', ownerUserId: 'stagingmember' } })).status).toBe(200)
    const row = async () => ((await h.call('GET', '/v1/audit-log?category=workspaces', { bearer: admin })).body.events as Array<{ action: string; detail: Record<string, unknown> }>).find((event) => event.action === 'workspace.owner_changed')!
    // What END-PASS saw: the id and no name.
    expect((await row()).detail).toEqual({ fromUserId: 'ada', toUserId: 'stagingmember' })

    expect((await names({ accountId: 'org:acme', members: [{ userId: 'stagingmember', name: 'Orca Staging Member' }] })).body).toEqual({ saved: 1 })
    expect((await row()).detail).toEqual({ fromUserId: 'ada', toUserId: 'stagingmember', toUserName: 'Orca Staging Member' })
    const csv = await (await h.send(new Request('https://sandbox.test/v1/audit-log?format=csv&category=workspaces', { headers: { authorization: `Bearer ${admin}` } }))).text()
    expect(csv).toContain('Orca Staging Member')
  })

  it('are saved once, replaced when auth sends a different one, and cleaned like a token name', async () => {
    const { names, stored } = await setup()
    const first = { accountId: 'org:acme', members: [{ userId: 'u1', name: 'Grace Hopper' }, { userId: 'u2', name: '  Linus\n"Park"  ' }, { userId: 'u3', name: '\u0000\u0001' }] }
    expect((await names(first)).body).toEqual({ saved: 2 })
    expect(stored()).toEqual([
      { account_id: 'org:acme', user_id: 'u1', name: 'Grace Hopper' },
      { account_id: 'org:acme', user_id: 'u2', name: 'Linus Park' }
    ])
    // The same again writes nothing; a new name replaces the old.
    expect((await names(first)).body).toEqual({ saved: 0 })
    expect((await names({ accountId: 'org:acme', members: [{ userId: 'u1', name: 'Grace B. Hopper' }] })).body).toEqual({ saved: 1 })
    expect(stored()[0]!.name).toBe('Grace B. Hopper')
    expect((await names({ accountId: 'org:acme', members: [{ userId: 'u1', name: 'x'.repeat(200) }] })).status).toBe(200)
    expect(stored()[0]!.name).toHaveLength(80)
  })

  it("take auth's bearer or the operator's, a team account, and a bounded list", async () => {
    const { h, admin, names } = await setup()
    const body = { accountId: 'org:acme', members: [{ userId: 'u1', name: 'Grace Hopper' }] }
    expect((await names(body, OPERATOR)).status).toBe(200)
    for (const bearer of [BILLING_TOKEN, admin, 'x'.repeat(40)]) {
      expect((await names(body, bearer)).status).toBe(404)
    }
    for (const bad of [
      { accountId: 'user:u1', members: body.members },
      { accountId: 'org:acme', members: [] },
      { accountId: 'org:acme', members: [{ userId: 'u 1', name: 'x' }] },
      { accountId: 'org:acme', members: [{ userId: 'u1', name: '' }] },
      { accountId: 'org:acme', members: [{ userId: 'u1', name: 'x', role: 'owner' }] },
      { accountId: 'org:acme', members: Array.from({ length: 201 }, (_, i) => ({ userId: `u${i}`, name: 'x' })) }
    ]) {
      expect((await names(bad)).status).toBe(400)
    }
    // Auth's bearer still opens none of the operator routes.
    expect((await h.call('GET', '/v1/internal/status', { bearer: AUTH_TOKEN })).status).toBe(404)
  })
})

describe('names are labels only', () => {
  it('a name on file gives no access: not to the team, its log, or admin routes', async () => {
    const { h, names, stored } = await setup()
    expect((await names({ accountId: 'org:acme', members: [{ userId: 'mallory', name: 'Olga Owner' }] })).status).toBe(200)
    expect(stored()).toHaveLength(1)
    // Mallory is not in Acme: her own token is for her personal account, and for another team.
    const personal = await h.token('mallory')
    const elsewhere = await h.token('mallory', 'globex', 'sandbox', { org_role: 'owner' })
    expect((await h.call('GET', '/v1/audit-log', { bearer: personal })).status).toBe(403)
    expect((await h.call('GET', '/v1/audit-log', { bearer: elsewhere })).body.events).toEqual([])
    expect((await h.call('GET', '/v1/team/workspaces', { bearer: elsewhere })).body.workspaces ?? []).toEqual([])
    // A member of Acme with an owner's name on file is still a member.
    await names({ accountId: 'org:acme', members: [{ userId: 'bob', name: 'Olga Owner' }] })
    const bob = await h.token('bob', 'acme', 'sandbox', { org_role: 'member' })
    expect((await h.call('GET', '/v1/audit-log', { bearer: bob })).status).toBe(403)
    expect((await h.call('POST', '/v1/api-keys', { bearer: bob, body: { name: 'x', scopes: ['audit:read'] } })).status).toBe(403)
  })

  it('no code that decides access reads the names table or the names module', () => {
    const src = fileURLToPath(new URL('../src', import.meta.url).href)
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(path)
        } else if (entry.name.endsWith('.ts')) {
          files.push(path)
        }
      }
    }
    walk(src)
    const relative = (path: string): string => path.slice(src.length + 1)
    // Only the names module touches the table.
    const tableReaders = files.filter((path) => /\bmember_names\b/.test(readFileSync(path, 'utf8'))).map(relative)
    expect(tableReaders).toEqual(['member-names.ts'])
    // The modules that decide who may do what never import it.
    const deciders = ['auth.ts', 'api/access.ts', 'api/caller.ts', 'api/keys.ts', 'member-changes.ts', 'member-removal.ts', 'api/member-role-sync.ts', 'grants.ts', 'secrets.ts', 'share-links.ts', 'device-sessions.ts']
    for (const name of deciders) {
      const text = readFileSync(join(src, name), 'utf8')
      expect([name, /from '\.{1,2}\/(?:\.\.\/)?member-names'/.test(text)]).toEqual([name, false])
    }
    // And the names module exports labels only: nothing that answers a yes/no about a person.
    const exported = [...readFileSync(join(src, 'member-names.ts'), 'utf8').matchAll(/export (?:async )?(?:function|const) (\w+)/g)].map((match) => match[1])
    expect(exported.sort()).toEqual(['MemberNamesSchema', 'memberNamesFor', 'rememberCallerName', 'rememberMemberNames'])
  })
})
