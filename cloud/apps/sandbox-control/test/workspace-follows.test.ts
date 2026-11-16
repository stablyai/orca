import { describe, expect, it } from 'vitest'
import { createHarness } from './harness'

const AUTH_TOKEN = 'a'.repeat(40)

async function team() {
  const h = await createHarness({ OPERATOR_TOKEN: 'o'.repeat(40), MEMBER_REMOVED_TOKEN: AUTH_TOKEN })
  type Who = { sub: string; orgRole: 'owner' | 'admin' | 'member' }
  const req = async (who: Who, method: string, path: string, body?: unknown) =>
    h.call(method, path, { bearer: await h.token(who.sub, 'acme', 'sandbox', { org_role: who.orgRole }), body })
  const alice: Who = { sub: 'alice', orgRole: 'member' }
  const bob: Who = { sub: 'bob', orgRole: 'member' }
  const carol: Who = { sub: 'carol', orgRole: 'member' }
  const olga: Who = { sub: 'olga', orgRole: 'admin' }
  const create = async (who: Who) => {
    const made = await req(who, 'POST', '/v1/sandboxes', { workspaceId: `ws-${Math.random()}`, machineSize: 'standard', title: 'W' })
    expect(made.status).toBe(200)
    return made.body.sandbox.id as string
  }
  const internal = (path: string, body: unknown) => h.call('POST', path, { body, bearer: AUTH_TOKEN })
  return { h, req, alice, bob, carol, olga, create, internal }
}

describe('workspace follows (only the owner can see a workspace now)', () => {
  it('teammates and admins cannot follow, even a row still stored as team; the owner sees only their own follow', async () => {
    const t = await team()
    const id = await t.create(t.alice)
    t.h.raw.prepare("UPDATE sandboxes SET visibility = 'team' WHERE id = ?").run(id)
    expect((await t.req(t.bob, 'PUT', `/v1/team/workspaces/${id}/follow`)).status).toBe(404)
    expect((await t.req(t.olga, 'PUT', `/v1/team/workspaces/${id}/follow`)).status).toBe(404)
    // A follow left from before is never shown.
    t.h.raw.prepare('INSERT INTO workspace_follows (sandbox_id, account_id, user_id, created_at) VALUES (?, ?, ?, 1)').run(id, 'org:acme', 'bob')
    expect((await t.req(t.alice, 'PUT', `/v1/team/workspaces/${id}/follow`)).body).toEqual({ following: true, followers: ['alice'] })
    const adminView = (await t.req(t.olga, 'GET', '/v1/team/workspaces?scope=all')).body.workspaces.find((w: { id: string }) => w.id === id)
    expect(adminView.followers).toEqual([])
  })

  it('forgets every follow of a destroyed workspace', async () => {
    const t = await team()
    const id = await t.create(t.alice)
    await t.req(t.alice, 'PUT', `/v1/team/workspaces/${id}/follow`)
    expect((await t.req(t.alice, 'DELETE', `/v1/sandboxes/${id}`)).status).toBe(200)
    const left = t.h.raw.prepare('SELECT COUNT(*) AS n FROM workspace_follows WHERE sandbox_id = ?').get(id) as { n: number }
    expect(left.n).toBe(0)
  })
})
