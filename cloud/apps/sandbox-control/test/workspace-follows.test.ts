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
  const create = async (who: Who, visibility: 'team' | 'private') => {
    const made = await req(who, 'POST', '/v1/sandboxes', { workspaceId: `ws-${Math.random()}`, machineSize: 'standard', title: 'W' })
    expect(made.status).toBe(200)
    const id = made.body.sandbox.id as string
    if (visibility === 'team') {
      await req(who, 'PATCH', `/v1/team/workspaces/${id}`, { visibility: 'team' })
    }
    return id
  }
  const internal = (path: string, body: unknown) => h.call('POST', path, { body, bearer: AUTH_TOKEN })
  return { h, req, alice, bob, carol, olga, create, internal }
}

describe('workspace follows (PARITY-FOLLOW)', () => {
  it('follows and unfollows; everyone who can see it sees followers, oldest first', async () => {
    const t = await team()
    const id = await t.create(t.alice, 'team')
    const bobFollow = await t.req(t.bob, 'PUT', `/v1/team/workspaces/${id}/follow`)
    expect(bobFollow.status).toBe(200)
    expect(bobFollow.body).toEqual({ following: true, followers: ['bob'] })
    t.h.advance(1_000)
    await t.req(t.carol, 'PUT', `/v1/team/workspaces/${id}/follow`)
    // Following twice is a no-op, and keeps Bob first.
    await t.req(t.bob, 'PUT', `/v1/team/workspaces/${id}/follow`)

    const seenByAlice = (await t.req(t.alice, 'GET', `/v1/team/workspaces/${id}`)).body.workspace
    expect(seenByAlice).toMatchObject({ followers: ['bob', 'carol'], following: false })
    const listed = (await t.req(t.carol, 'GET', '/v1/team/workspaces?scope=team')).body.workspaces
    expect(listed.find((w: { id: string }) => w.id === id)).toMatchObject({ followers: ['bob', 'carol'], following: true })

    const unfollow = await t.req(t.bob, 'DELETE', `/v1/team/workspaces/${id}/follow`)
    expect(unfollow.body).toEqual({ following: false, followers: ['carol'] })
  })

  it("can't follow a private workspace you can't see, and old follows vanish when it turns private", async () => {
    const t = await team()
    const secret = await t.create(t.alice, 'private')
    expect((await t.req(t.bob, 'PUT', `/v1/team/workspaces/${secret}/follow`)).status).toBe(404)
    // An admin may address a private row for management, but not follow it.
    expect((await t.req(t.olga, 'PUT', `/v1/team/workspaces/${secret}/follow`)).status).toBe(404)

    const shared = await t.create(t.alice, 'team')
    await t.req(t.bob, 'PUT', `/v1/team/workspaces/${shared}/follow`)
    t.h.advance(1_000)
    await t.req(t.alice, 'PUT', `/v1/team/workspaces/${shared}/follow`)
    await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${shared}`, { visibility: 'private' })
    // The owner still sees their own follow; Bob's is never shown while it is private.
    const own = (await t.req(t.alice, 'GET', `/v1/team/workspaces/${shared}`)).body.workspace
    expect(own).toMatchObject({ followers: ['alice'], following: true })
    const adminView = (await t.req(t.olga, 'GET', '/v1/team/workspaces?scope=all')).body.workspaces.find(
      (w: { id: string }) => w.id === shared
    )
    expect(adminView.followers).toEqual([])
    // Shared again: Bob's follow is back (it was hidden, not lost).
    await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${shared}`, { visibility: 'team' })
    expect((await t.req(t.bob, 'GET', `/v1/team/workspaces/${shared}`)).body.workspace).toMatchObject({
      followers: ['bob', 'alice'],
      following: true
    })
  })

  it('forgets every follow of a destroyed workspace', async () => {
    const t = await team()
    const id = await t.create(t.alice, 'team')
    await t.req(t.bob, 'PUT', `/v1/team/workspaces/${id}/follow`)
    expect((await t.req(t.alice, 'DELETE', `/v1/sandboxes/${id}`)).status).toBe(200)
    const left = t.h.raw.prepare('SELECT COUNT(*) AS n FROM workspace_follows WHERE sandbox_id = ?').get(id) as { n: number }
    expect(left.n).toBe(0)
  })

  it("forgets a removed member's follows, so they stop showing as a follower", async () => {
    const t = await team()
    const id = await t.create(t.alice, 'team')
    await t.req(t.bob, 'PUT', `/v1/team/workspaces/${id}/follow`)
    await t.req(t.carol, 'PUT', `/v1/team/workspaces/${id}/follow`)
    expect((await t.internal('/v1/internal/org-members/removed', { accountId: 'org:acme', userId: 'bob' })).status).toBe(200)
    expect((await t.req(t.alice, 'GET', `/v1/team/workspaces/${id}`)).body.workspace.followers).toEqual(['carol'])
  })
})
