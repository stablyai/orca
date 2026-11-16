// TEAM-SHARING hold (team-sharing.ts): with TEAM_SHARING off, nothing can be shared with the team, and a
// workspace already stored as `team` acts private everywhere (owner only, plus org admins' metadata).
import { describe, expect, it } from 'vitest'
import { generateGrantRecipientKey } from '../../../../src/main/cloud-workspaces/sealed-grant-node'
import { createHarness } from './harness'

async function held(teamSharing: 'off' | undefined = 'off') {
  const h = await createHarness({ PUBLIC_API_URL: 'https://api.test', ...(teamSharing ? { TEAM_SHARING: teamSharing } : { TEAM_SHARING: undefined }) })
  const token = (sub: string, role: 'member' | 'admin' = 'member') => h.token(sub, 'acme', 'sandbox', { org_role: role })
  const created = await h.call('POST', '/v1/sandboxes', {
    bearer: await token('alice'),
    body: { workspaceId: 'ws-1', machineSize: 'standard', title: 'Fix login', repo: { url: 'https://github.com/acme/app' }, visibility: 'team' }
  })
  expect(created.status).toBe(200)
  return { h, token, id: created.body.sandbox.id as string }
}

describe('TEAM_SHARING held (the default)', () => {
  it('a create asking for team is private, a PATCH to team is refused, and the list says sharing is off', async () => {
    for (const setting of ['off', undefined] as const) {
      const t = await held(setting)
      expect(t.h.raw.prepare('SELECT visibility FROM sandboxes WHERE id = ?').get(t.id)).toEqual({ visibility: 'private' })
      const patch = await t.h.call('PATCH', `/v1/team/workspaces/${t.id}`, { bearer: await t.token('alice'), body: { visibility: 'team' } })
      expect(patch.status).toBe(400)
      expect(patch.body).toEqual({ error: 'invalid_request', reason: 'team_sharing_unavailable' })
      const list = await t.h.call('GET', '/v1/team/workspaces', { bearer: await t.token('alice') })
      expect(list.body.teamSharing).toBe(false)
      // Other edits still work, and making it private is always allowed.
      expect((await t.h.call('PATCH', `/v1/team/workspaces/${t.id}`, { bearer: await t.token('alice'), body: { visibility: 'private', section: 'Auth' } })).status).toBe(200)
    }
  })

  it('a workspace already stored as team acts private: owner only, admins see metadata, teammates nothing', async () => {
    const t = await held()
    t.h.raw.prepare("UPDATE sandboxes SET visibility = 'team' WHERE id = ?").run(t.id)
    const bob = await t.token('bob')
    // Team registry: not listed, not addressable, no grant, no follow.
    expect((await t.h.call('GET', '/v1/team/workspaces?scope=team', { bearer: bob })).body.workspaces).toEqual([])
    expect((await t.h.call('GET', `/v1/team/workspaces/${t.id}`, { bearer: bob })).status).toBe(404)
    const grant = await t.h.call('POST', `/v1/team/workspaces/${t.id}/grants`, {
      bearer: bob,
      body: { recipientPublicKeyB64: generateGrantRecipientKey().publicKeyB64, deviceLabel: 'b', deviceKind: 'desktop' }
    })
    expect(grant.status).toBe(404)
    expect((await t.h.call('PUT', `/v1/team/workspaces/${t.id}/follow`, { bearer: bob })).status).toBe(404)
    // Public API and MCP's rule (api/access.ts): nothing for a teammate.
    expect((await t.h.call('GET', '/v1/workspaces', { bearer: bob })).body.workspaces).toEqual([])
    expect((await t.h.call('GET', `/v1/workspaces/${t.id}`, { bearer: bob })).status).toBe(404)
    expect((await t.h.call('POST', `/v1/workspaces/${t.id}/messages`, { bearer: bob, body: { text: 'hi' } })).status).toBe(404)
    // The owner sees it as private (what access follows); the stored value is kept for when sharing ships.
    const own = await t.h.call('GET', `/v1/team/workspaces/${t.id}`, { bearer: await t.token('alice') })
    expect(own.body.workspace).toMatchObject({ visibility: 'private', access: 'owner' })
    expect(t.h.raw.prepare('SELECT visibility FROM sandboxes WHERE id = ?').get(t.id)).toEqual({ visibility: 'team' })
    // An admin keeps today's management view (scope=all metadata), not the teammate view.
    const admin = await t.token('carol', 'admin')
    const all = await t.h.call('GET', '/v1/team/workspaces?scope=all', { bearer: admin })
    expect(all.body.workspaces.map((w: { id: string; visibility: string; access: string }) => [w.id, w.visibility, w.access])).toEqual([[t.id, 'private', 'none']])
    expect((await t.h.call('GET', '/v1/team/workspaces?scope=team', { bearer: admin })).body.workspaces).toEqual([])
  })

  it('TEAM_SHARING=on restores each workspace’s own setting', async () => {
    const h = await createHarness()
    const alice = await h.token('alice', 'acme', 'sandbox', { org_role: 'member' })
    const created = await h.call('POST', '/v1/sandboxes', {
      bearer: alice,
      body: { workspaceId: 'ws-1', machineSize: 'standard', repo: { url: 'https://github.com/acme/app' }, visibility: 'team' }
    })
    const bob = await h.token('bob', 'acme', 'sandbox', { org_role: 'member' })
    const list = await h.call('GET', '/v1/team/workspaces?scope=team', { bearer: bob })
    expect(list.body.teamSharing).toBe(true)
    expect(list.body.workspaces.map((w: { id: string; visibility: string }) => [w.id, w.visibility])).toEqual([[created.body.sandbox.id, 'team']])
  })
})
