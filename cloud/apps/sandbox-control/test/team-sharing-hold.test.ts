// TEAM-SHARING hold (team-sharing.ts): with TEAM_SHARING off, nothing can be shared with the team, and a
// workspace already stored as `team` acts private everywhere (owner only, plus org admins' metadata).
import { describe, expect, it } from 'vitest'
import { generateGrantRecipientKey } from '../../../../src/main/cloud-workspaces/sealed-grant-node'
import { sweepHeldTeamGrants } from '../src/grants'
import { lifecycleDeps } from '../src/index'
import { resolveSandboxSecrets } from '../src/secrets'
import { sharedWorkspaceMode } from '../src/shared-workspace'
import { getSandbox } from '../src/store'
import { configureTeamSharing } from '../src/team-sharing'
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
    expect(own.body.teamSharing).toBe(false)
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

  it('the sweep revokes teammates’ grants on a held team workspace; credentials stay shared until it has', async () => {
    // Shared while sharing was on: Bob holds a device grant.
    const h = await createHarness({ SECRETS_KEK: Buffer.alloc(32, 7).toString('base64') })
    const alice = await h.token('alice', 'acme', 'sandbox', { org_role: 'member' })
    const created = await h.call('POST', '/v1/sandboxes', {
      bearer: alice,
      body: { workspaceId: 'ws-1', machineSize: 'standard', repo: { url: 'https://github.com/acme/app' }, visibility: 'team' }
    })
    const id = created.body.sandbox.id as string
    const grant = await h.call('POST', `/v1/team/workspaces/${id}/grants`, {
      bearer: await h.token('bob', 'acme', 'sandbox', { org_role: 'member' }),
      body: { recipientPublicKeyB64: generateGrantRecipientKey().publicKeyB64, deviceLabel: 'b', deviceKind: 'desktop' }
    })
    expect(grant.status).toBe(200)
    // Now held.
    h.env.TEAM_SHARING = undefined
    configureTeamSharing(h.env)
    const db = h.env.SANDBOX_DB
    const row = (await getSandbox(db, id))!
    // Bob's grant is still active: shared mode (no personal credentials), though it acts private.
    expect(await sharedWorkspaceMode(db, row)).toBe(true)
    expect((await h.call('PUT', '/v1/secrets/personal/MY_TOKEN', { bearer: alice, body: { value: 'personal-value' } })).status).toBe(200)
    const life = (await lifecycleDeps(h.env, h.deps))!
    const keyring = await life.secrets!.keyring
    expect((await resolveSandboxSecrets(db, keyring, row)).env.MY_TOKEN).toBeUndefined()
    expect(await sweepHeldTeamGrants(life)).toEqual({ workspaces: 1, revoked: 1, queued: 0 })
    expect(h.raw.prepare('SELECT status, revoke_reason FROM workspace_grants WHERE user_id = ?').get('bob')).toEqual({ status: 'revoked', revoke_reason: 'team_sharing_held' })
    // Review M1: revoked during this session, so what Bob started may still run: shared until the next boot.
    expect(await sharedWorkspaceMode(db, row)).toBe(true)
    expect((await resolveSandboxSecrets(db, keyring, row)).env.MY_TOKEN).toBeUndefined()
    // A new session (restart): the owner's alone, so it acts private for credentials too.
    h.advance(1_000)
    expect((await h.call('POST', `/v1/sandboxes/${id}/restart`, { bearer: alice })).status).toBe(200)
    expect(await sharedWorkspaceMode(db, row)).toBe(false)
    expect((await resolveSandboxSecrets(db, keyring, row)).env.MY_TOKEN).toBe('personal-value')
    // Nothing left to sweep; and with sharing on again, nothing is swept at all.
    expect(await sweepHeldTeamGrants(life)).toEqual({ workspaces: 0, revoked: 0, queued: 0 })
    configureTeamSharing({ TEAM_SHARING: 'on' })
    expect(await sharedWorkspaceMode(db, row)).toBe(true)
  })

  it('review L1: the sweep leaves private workspaces alone', async () => {
    const t = await held()
    t.h.raw
      .prepare(`INSERT INTO workspace_grants (id, sandbox_id, account_id, user_id, device_kind, device_label, status, created_at) VALUES ('grt_p', ?, 'org:acme', 'bob', 'desktop', 'b', 'active', 1)`)
      .run(t.id)
    expect(await sweepHeldTeamGrants((await lifecycleDeps(t.h.env, t.h.deps))!)).toEqual({ workspaces: 0, revoked: 0, queued: 0 })
  })

  it('review L2: concurrent sweeps revoke each grant once and agree on the end state', async () => {
    const h = await createHarness()
    const alice = await h.token('alice', 'acme', 'sandbox', { org_role: 'member' })
    const created = await h.call('POST', '/v1/sandboxes', {
      bearer: alice,
      body: { workspaceId: 'ws-1', machineSize: 'standard', repo: { url: 'https://github.com/acme/app' }, visibility: 'team' }
    })
    const id = created.body.sandbox.id as string
    for (const who of ['bob', 'dan']) {
      const g = await h.call('POST', `/v1/team/workspaces/${id}/grants`, {
        bearer: await h.token(who, 'acme', 'sandbox', { org_role: 'member' }),
        body: { recipientPublicKeyB64: generateGrantRecipientKey().publicKeyB64, deviceLabel: who, deviceKind: 'desktop' }
      })
      expect(g.status).toBe(200)
    }
    h.env.TEAM_SHARING = undefined
    configureTeamSharing(h.env)
    const life = (await lifecycleDeps(h.env, h.deps))!
    const [a, b] = await Promise.all([sweepHeldTeamGrants(life), sweepHeldTeamGrants(life)])
    expect(a.revoked + a.queued + b.revoked + b.queued).toBeGreaterThanOrEqual(2)
    expect(h.raw.prepare(`SELECT user_id, status, revoke_reason FROM workspace_grants WHERE user_id <> 'alice' ORDER BY user_id`).all()).toEqual([
      { user_id: 'bob', status: 'revoked', revoke_reason: 'team_sharing_held' },
      { user_id: 'dan', status: 'revoked', revoke_reason: 'team_sharing_held' }
    ])
    expect(await sweepHeldTeamGrants(life)).toEqual({ workspaces: 0, revoked: 0, queued: 0 })
  })
})

describe('Make private keeps shared credential mode until the next boot (same rule as the sweep)', () => {
  it('a teammate revoked by Make private leaves this session shared; a fresh boot is private', async () => {
    const h = await createHarness({ SECRETS_KEK: Buffer.alloc(32, 7).toString('base64') })
    const alice = await h.token('alice', 'acme', 'sandbox', { org_role: 'member' })
    const created = await h.call('POST', '/v1/sandboxes', {
      bearer: alice,
      body: { workspaceId: 'ws-1', machineSize: 'standard', repo: { url: 'https://github.com/acme/app' }, visibility: 'team' }
    })
    const id = created.body.sandbox.id as string
    const g = await h.call('POST', `/v1/team/workspaces/${id}/grants`, {
      bearer: await h.token('bob', 'acme', 'sandbox', { org_role: 'member' }),
      body: { recipientPublicKeyB64: generateGrantRecipientKey().publicKeyB64, deviceLabel: 'b', deviceKind: 'desktop' }
    })
    expect(g.status).toBe(200)
    expect((await h.call('PATCH', `/v1/team/workspaces/${id}`, { bearer: alice, body: { visibility: 'private' } })).status).toBe(200)
    const db = h.env.SANDBOX_DB
    expect(h.raw.prepare('SELECT status FROM workspace_grants WHERE user_id = ?').get('bob')).toEqual({ status: 'revoked' })
    const row = (await getSandbox(db, id))!
    expect(row.visibility).toBe('private')
    expect(await sharedWorkspaceMode(db, row)).toBe(true)
    h.advance(1_000)
    expect((await h.call('POST', `/v1/sandboxes/${id}/restart`, { bearer: alice })).status).toBe(200)
    expect(await sharedWorkspaceMode(db, (await getSandbox(db, id))!)).toBe(false)
  })

  it('a revoke queued while the workspace slept leaves its next session private (no lost sign-in after the deploy sweep)', async () => {
    const h = await createHarness({ SECRETS_KEK: Buffer.alloc(32, 7).toString('base64') })
    const alice = await h.token('alice', 'acme', 'sandbox', { org_role: 'member' })
    const created = await h.call('POST', '/v1/sandboxes', {
      bearer: alice,
      body: { workspaceId: 'ws-1', machineSize: 'standard', repo: { url: 'https://github.com/acme/app' }, visibility: 'team' }
    })
    const id = created.body.sandbox.id as string
    const g = await h.call('POST', `/v1/team/workspaces/${id}/grants`, {
      bearer: await h.token('bob', 'acme', 'sandbox', { org_role: 'member' }),
      body: { recipientPublicKeyB64: generateGrantRecipientKey().publicKeyB64, deviceLabel: 'b', deviceKind: 'desktop' }
    })
    expect(g.status).toBe(200)
    expect((await h.call('POST', `/v1/sandboxes/${id}/suspend`, { bearer: alice })).status).toBe(200)
    h.env.TEAM_SHARING = undefined
    configureTeamSharing(h.env)
    const life = (await lifecycleDeps(h.env, h.deps))!
    // Asleep: queued, not applied.
    expect(await sweepHeldTeamGrants(life)).toEqual({ workspaces: 1, revoked: 0, queued: 1 })
    const db = h.env.SANDBOX_DB
    const queuedAt = (h.raw.prepare('SELECT revoked_at FROM workspace_grants WHERE user_id = ?').get('bob') as { revoked_at: number }).revoked_at
    expect(await sharedWorkspaceMode(db, (await getSandbox(db, id))!)).toBe(false)
    h.advance(60_000)
    expect((await h.call('POST', `/v1/sandboxes/${id}/resume`, { bearer: alice })).status).toBe(200)
    // Applied at boot, still stamped with the queue time; the new session is private.
    expect(h.raw.prepare('SELECT status, revoked_at FROM workspace_grants WHERE user_id = ?').get('bob')).toEqual({ status: 'revoked', revoked_at: queuedAt })
    expect(await sharedWorkspaceMode(db, (await getSandbox(db, id))!)).toBe(false)
  })
})

