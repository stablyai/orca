import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { generateGrantRecipientKey, nodeSealedGrantPrimitives } from '../../../../src/main/cloud-workspaces/sealed-grant-node'
import { openSealedGrant } from '../../../../src/shared/cloud-workspaces/sealed-grant'
import { HostedWakeResponseSchema } from '../../../../src/shared/hosted-sandbox/hosted-sandbox-wire'
import { REVOKE_COMMAND } from '../src/grant-revokes'
import { GRANT_COMMAND } from '../src/grants'
import { createHarness } from './harness'

const MIN = 60_000

async function team() {
  const h = await createHarness()
  type Who = { sub: string; orgRole: 'owner' | 'admin' | 'member'; org: string }
  // A person, not a token: every request mints a fresh one so clock advances never expire it.
  const as = async (sub: string, orgRole: Who['orgRole'] = 'member', org = 'acme'): Promise<Who> => ({ sub, orgRole, org })
  const req = async (who: Who, method: string, path: string, body?: unknown) =>
    h.call(method, path, { bearer: await h.token(who.sub, who.org, 'sandbox', { org_role: who.orgRole }), body })
  const alice = await as('alice')
  const bob = await as('bob')
  const admin = await as('carol', 'admin')
  const created = await req(alice, 'POST', '/v1/sandboxes', {
    workspaceId: 'ws-1',
    machineSize: 'standard',
    title: 'Fix login',
    repo: { url: 'https://github.com/acme/app', ref: 'fix/login' }
  })
  expect(created.status).toBe(200)
  return { h, as, req, alice, bob, admin, id: created.body.sandbox.id as string, created }
}

describe('workspace registry', () => {
  it('lists private workspaces to their owner only, team ones to the org', async () => {
    const t = await team()
    const mine = await t.req(t.alice, 'GET', '/v1/team/workspaces?scope=mine')
    expect(mine.body.workspaces).toHaveLength(1)
    expect(mine.body.workspaces[0]).toMatchObject({
      id: t.id,
      title: 'Fix login',
      repo: { url: 'https://github.com/acme/app', branch: 'fix/login' },
      visibility: 'private',
      createdBy: 'alice',
      ownerUserId: 'alice',
      access: 'owner'
    })
    expect((await t.req(t.bob, 'GET', '/v1/team/workspaces')).body.workspaces).toEqual([])
    expect((await t.req(t.bob, 'GET', `/v1/team/workspaces/${t.id}`)).status).toBe(404)
    // Teammates cannot reach the owner's lifecycle API (resume would hand out a pairing offer).
    expect((await t.req(t.bob, 'POST', `/v1/sandboxes/${t.id}/resume`)).status).toBe(404)
    expect((await t.req(t.bob, 'GET', '/v1/sandboxes')).body.sandboxes).toEqual([])

    expect((await t.req(t.bob, 'PATCH', `/v1/team/workspaces/${t.id}`, { visibility: 'team' })).status).toBe(404)
    const shared = await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${t.id}`, { visibility: 'team', section: 'Auth' })
    expect(shared.body.workspace).toMatchObject({ visibility: 'team', section: 'Auth' })
    const seen = await t.req(t.bob, 'GET', '/v1/team/workspaces?scope=team')
    expect(seen.body.workspaces.map((w: { id: string; access: string }) => [w.id, w.access])).toEqual([[t.id, 'can_open']])
    expect((await t.req(t.bob, 'GET', '/v1/team/workspaces?scope=mine')).body.workspaces).toEqual([])
    expect((await t.req(t.bob, 'GET', '/v1/team/workspaces?by=alice&section=Auth')).body.workspaces).toHaveLength(1)
    expect((await t.req(t.bob, 'GET', '/v1/team/workspaces?by=dave')).body.workspaces).toEqual([])
    // Members cannot edit a teammate's workspace; another org sees nothing.
    expect((await t.req(t.bob, 'PATCH', `/v1/team/workspaces/${t.id}`, { title: 'mine now' })).status).toBe(403)
    const stranger = await t.as('eve', 'owner', 'other')
    expect((await t.req(stranger, 'GET', `/v1/team/workspaces/${t.id}`)).status).toBe(404)
    expect((await t.req(stranger, 'GET', `/v1/team/links/resolve?w=${t.id}`)).status).toBe(404)
  })

  it('keeps routine runs off Home unless the Routine runs filter asks for them', async () => {
    const t = await team()
    // A routine run's VM: hidden and tagged with its routine (what routines/runs.ts creates).
    expect((await t.req(t.alice, 'GET', '/v1/team/workspaces?scope=mine')).body.routineRuns).toEqual({ routines: 0, hidden: 0, hiddenRunning: 0, hiddenComputeMs: 0 })
    t.h.raw
      .prepare(
        `INSERT INTO routines (id, account_id, created_by, name, project_id, trigger_kind, trigger_config, agent, prompt, max_runtime_ms, created_at, updated_at)
         VALUES ('rtn_1', 'org:acme', 'alice', 'nightly-deps', 'prj_1', 'webhook', '{}', 'claude', 'x', 60000, 0, 0)`
      )
      .run()
    t.h.raw.prepare(`UPDATE sandboxes SET hidden = 1, origin = 'routine', origin_ref = 'rtn_1' WHERE id = ?`).run(t.id)
    const off = await t.req(t.alice, 'GET', '/v1/team/workspaces?scope=mine')
    expect(off.body.workspaces).toEqual([])
    // What the switch hides is still counted for Home: the switch label and the team's hours.
    expect(off.body.routineRuns).toMatchObject({ routines: 1, hidden: 1, hiddenRunning: 1 })
    const shown = await t.req(t.alice, 'GET', '/v1/team/workspaces?scope=mine&routines=include')
    expect(shown.body.workspaces.map((w: { id: string; fromRoutine: boolean; routineName: string }) => [w.id, w.fromRoutine, w.routineName])).toEqual([
      [t.id, true, 'nightly-deps']
    ])
    expect(shown.body.routineRuns).toMatchObject({ routines: 1, hidden: 0, hiddenRunning: 0 })
    // Other machine-made rows stay hidden even then.
    t.h.raw.prepare(`UPDATE sandboxes SET origin = 'vm' WHERE id = ?`).run(t.id)
    expect((await t.req(t.alice, 'GET', '/v1/team/workspaces?scope=mine&routines=include')).body.workspaces).toEqual([])
    // A plain workspace says so.
    t.h.raw.prepare(`UPDATE sandboxes SET hidden = 0, origin = 'desktop' WHERE id = ?`).run(t.id)
    expect((await t.req(t.alice, 'GET', '/v1/team/workspaces?scope=mine')).body.workspaces[0].fromRoutine).toBe(false)
    expect((await t.req(t.alice, 'GET', '/v1/team/workspaces?routines=bogus')).status).toBe(400)
  })

  it('lets admins see private rows for management (scope=all) without access', async () => {
    const t = await team()
    expect((await t.req(t.bob, 'GET', '/v1/team/workspaces?scope=all')).status).toBe(403)
    const all = await t.req(t.admin, 'GET', '/v1/team/workspaces?scope=all')
    expect(all.body.workspaces).toHaveLength(1)
    expect(all.body.workspaces[0]).toMatchObject({ access: 'none', presence: [] })
    // Admin can archive a member's workspace and suspend it, but not resume it.
    const archived = await t.req(t.admin, 'PATCH', `/v1/team/workspaces/${t.id}`, { archived: true })
    expect(archived.body.workspace.archivedAt).toBe(t.h.now())
    expect((await t.req(t.alice, 'GET', '/v1/team/workspaces')).body.workspaces).toEqual([])
    expect((await t.req(t.alice, 'GET', '/v1/team/workspaces?archived=only')).body.workspaces).toHaveLength(1)
    expect((await t.req(t.admin, 'POST', `/v1/sandboxes/${t.id}/suspend`)).status).toBe(200)
    expect((await t.req(t.admin, 'POST', `/v1/sandboxes/${t.id}/resume`)).status).toBe(404)
  })

  it('archives for real from the team list: the sandbox stops with a snapshot TTL; unarchive leaves it asleep', async () => {
    const t = await team()
    const name = `orca-test-${t.id}`
    expect(t.h.vercel.boxes.get(name)!.status).toBe('running')
    const archived = await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${t.id}`, { archived: true })
    expect(archived.status).toBe(200)
    expect(archived.body.workspace.archivedAt).toBe(t.h.now())
    expect(t.h.vercel.boxes.get(name)!.status).toBe('stopped')
    expect(t.h.raw.prepare('SELECT status, archive_expires_at FROM sandboxes WHERE id = ?').get(t.id)).toMatchObject({
      status: 'archived'
    })
    expect(t.h.vercel.snapshotExpirations.get(name)).toBe(37 * 24 * 60 * MIN)
    const restored = await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${t.id}`, { archived: false })
    expect(restored.body.workspace.archivedAt).toBeNull()
    expect(t.h.raw.prepare('SELECT status FROM sandboxes WHERE id = ?').get(t.id)).toEqual({ status: 'suspended' })
    // Restoring does not start (or bill) the sandbox; opening it wakes it as usual.
    expect(t.h.vercel.boxes.get(name)!.status).toBe('stopped')
    expect(t.h.vercel.snapshotExpirations.get(name)).toBe(104 * 24 * 60 * MIN)
  })

  it('refuses to archive a sandbox that is starting or mid-transition, and leaves the row unchanged', async () => {
    const t = await team()
    for (const status of ['creating', 'suspending']) {
      t.h.raw.prepare(`UPDATE sandboxes SET status = ? WHERE id = ?`).run(status, t.id)
      const busy = await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${t.id}`, { archived: true })
      expect(busy).toMatchObject({ status: 409, body: { reason: `sandbox_${status}` } })
    }
    t.h.raw.prepare(`UPDATE sandboxes SET status = 'resuming' WHERE id = ?`).run(t.id)
    const res = await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${t.id}`, { archived: true })
    expect(res).toMatchObject({ status: 409, body: { error: 'conflict', reason: 'sandbox_resuming' } })
    expect(t.h.raw.prepare('SELECT status, archived_at FROM sandboxes WHERE id = ?').get(t.id)).toEqual({
      status: 'resuming',
      archived_at: null
    })
  })

  it('archives an asleep sandbox without waking it', async () => {
    const t = await team()
    await t.req(t.alice, 'POST', `/v1/sandboxes/${t.id}/suspend`)
    const { START_COMMAND } = await import('../src/sandbox-vm-commands')
    const starts = t.h.vercel.commands.filter((c) => c.command === START_COMMAND).length
    const res = await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${t.id}`, { archived: true })
    expect(res.status).toBe(200)
    expect(t.h.raw.prepare('SELECT status FROM sandboxes WHERE id = ?').get(t.id)).toEqual({ status: 'archived' })
    expect(t.h.vercel.commands.filter((c) => c.command === START_COMMAND)).toHaveLength(starts)
    expect(t.h.vercel.boxes.get(`orca-test-${t.id}`)!.status).toBe('stopped')
  })

  it('never labels a running sandbox archived when the archive itself fails', async () => {
    const t = await team()
    const { ProviderError } = await import('../src/sandbox-provider')
    t.h.vercel.stopSession = async () => {
      throw new ProviderError(500, 'internal_error')
    }
    const res = await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${t.id}`, { archived: true })
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect((t.h.raw.prepare('SELECT archived_at FROM sandboxes WHERE id = ?').get(t.id) as { archived_at: number | null }).archived_at).toBeNull()
  })

  it('only the owner or a team admin can archive', async () => {
    const t = await team()
    await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${t.id}`, { visibility: 'team' })
    expect((await t.req(t.bob, 'PATCH', `/v1/team/workspaces/${t.id}`, { archived: true })).status).toBe(403)
    expect(t.h.vercel.boxes.get(`orca-test-${t.id}`)!.status).toBe('running')
  })

  it('reports cost from metered compute at the billing rate, plus reported token spend', async () => {
    const t = await team()
    t.h.advance(90 * MIN)
    let [w] = (await t.req(t.alice, 'GET', '/v1/team/workspaces?scope=mine')).body.workspaces
    expect(w.cost).toMatchObject({ computeMs: 90 * MIN, rateUsdMicrosPerHour: 1_000_000, computeUsdMicros: 1_500_000, tokenUsdMicros: null })
    await t.req(t.alice, 'POST', `/v1/sandboxes/${t.id}/suspend`)
    t.h.advance(600 * MIN)
    await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${t.id}`, { tokenUsdMicros: 2_500_000 })
    ;[w] = (await t.req(t.alice, 'GET', '/v1/team/workspaces?scope=mine')).body.workspaces
    expect(w.cost).toMatchObject({ computeMs: 90 * MIN, computeUsdMicros: 1_500_000, tokenUsdMicros: 2_500_000, totalUsdMicros: 4_000_000 })
  })

  it('labels owners and present teammates with the name claim from their own tokens', async () => {
    const t = await team()
    const named = async (who: { sub: string; org: string }, name: string, method: string, path: string, body?: unknown) =>
      t.h.call(method, path, { bearer: await t.h.token(who.sub, who.org, 'sandbox', { org_role: 'member', name }), body })
    await named(t.alice, 'Alice  Lovelace\u0007', 'PATCH', `/v1/team/workspaces/${t.id}`, { visibility: 'team' })
    // Before Bob sends a named request, his id has no label (the roster or the id stands in).
    const before = await t.req(t.alice, 'GET', `/v1/team/workspaces/${t.id}`)
    expect(before.body.workspace.memberNames).toEqual({ alice: 'Alice Lovelace' })
    await named(t.bob, 'Bob B', 'POST', `/v1/team/workspaces/${t.id}/presence`, { clientId: 'b-1', state: 'viewing' })
    const after = await t.req(t.alice, 'GET', '/v1/team/workspaces')
    expect(after.body.workspaces[0].memberNames).toMatchObject({ bob: 'Bob B' })
    expect(after.body.workspaces[0].memberNames.alice).not.toContain('\u0007')
    // Another org never sees these labels.
    const other = await t.as('alice', 'member', 'globex')
    await t.req(other, 'POST', '/v1/sandboxes', { workspaceId: 'ws-x', machineSize: 'standard' })
    const theirs = await t.req(other, 'GET', '/v1/team/workspaces?scope=mine')
    expect(theirs.body.workspaces[0].memberNames).toEqual({})
  })

  it('tracks live presence per member device and expires it', async () => {
    const t = await team()
    await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${t.id}`, { visibility: 'team' })
    await t.req(t.alice, 'POST', `/v1/team/workspaces/${t.id}/presence`, { clientId: 'a-laptop', state: 'viewing' })
    const typed = await t.req(t.bob, 'POST', `/v1/team/workspaces/${t.id}/presence`, { clientId: 'b-1', state: 'typing', chatId: 'chat_9' })
    expect(typed.body.presence.map((p: { userId: string; state: string }) => `${p.userId}:${p.state}`).sort()).toEqual(['alice:viewing', 'bob:typing'])
    const [w] = (await t.req(t.alice, 'GET', '/v1/team/workspaces')).body.workspaces
    expect(w.lastActivityBy).toBe('alice')
    await t.req(t.bob, 'POST', `/v1/team/workspaces/${t.id}/presence`, { clientId: 'b-1', state: 'left' })
    t.h.advance(46_000)
    expect((await t.req(t.alice, 'GET', `/v1/team/workspaces/${t.id}`)).body.workspace.presence).toEqual([])
  })

  it('resolves deep links only for people who can see the workspace', async () => {
    const t = await team()
    expect((await t.req(t.bob, 'GET', `/v1/team/links/resolve?w=${t.id}&c=chat_1`)).status).toBe(404)
    await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${t.id}`, { visibility: 'team' })
    const link = await t.req(t.bob, 'GET', `/v1/team/links/resolve?w=${t.id}&c=chat_1`)
    expect(link.body).toMatchObject({ chatId: 'chat_1', workspace: { id: t.id, access: 'can_open' } })
    expect((await t.req(t.bob, 'GET', '/v1/team/links/resolve?w=nope')).status).toBe(400)
  })

  it('keeps personal-account workspaces private', async () => {
    const h = await createHarness()
    const { body } = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'p', machineSize: 'standard', visibility: 'team' } })
    const [w] = (await h.call('GET', '/v1/team/workspaces?scope=mine')).body.workspaces
    expect(w.visibility).toBe('private')
    expect((await h.call('PATCH', `/v1/team/workspaces/${body.sandbox.id}`, { body: { visibility: 'team' } })).body).toEqual({
      error: 'invalid_request',
      reason: 'personal_account'
    })
  })
})

describe('workspace grants (E2EE pairing through the control plane)', () => {
  it('seals a fresh single-device offer to the teammate device and nothing usable crosses the control plane', async () => {
    const t = await team()
    await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${t.id}`, { visibility: 'team' })
    const key = generateGrantRecipientKey()
    const res = await t.req(t.bob, 'POST', `/v1/team/workspaces/${t.id}/grants`, {
      recipientPublicKeyB64: key.publicKeyB64,
      deviceLabel: 'Bob MacBook',
      deviceKind: 'desktop'
    })
    expect(res.status).toBe(200)
    expect(res.body.grant).toMatchObject({ userId: 'bob', deviceKind: 'desktop', status: 'active' })
    const opened = await openSealedGrant(res.body.sealed, res.body.grant.id, key.secretKey, nodeSealedGrantPrimitives)
    expect(opened.pairingUrl).toMatch(/^orca:\/\/pair\?code=/)
    expect(opened.scope).toBe('runtime')
    // The box is bound to its grant id and to the requesting key.
    await expect(openSealedGrant(res.body.sealed, 'grt_other', key.secretKey, nodeSealedGrantPrimitives)).rejects.toThrow('decrypt_failed')
    await expect(openSealedGrant(res.body.sealed, res.body.grant.id, generateGrantRecipientKey().secretKey, nodeSealedGrantPrimitives)).rejects.toThrow('decrypt_failed')
    // D1 holds the device id for revocation, never the offer.
    const dump = JSON.stringify(t.h.raw.prepare('SELECT * FROM workspace_grants').all())
    expect(dump).not.toContain('orca://pair')
    expect(dump).not.toContain('tok-')
    const grantCmd = t.h.vercel.commands.find((c) => c.command === GRANT_COMMAND)!
    expect(grantCmd.env.ORCA_PUBLIC_WSS).toMatch(/^wss:\/\//)
  })

  it('refuses grants on private workspaces and wakes a sleeping team workspace for a teammate', async () => {
    const t = await team()
    const key = generateGrantRecipientKey()
    const body = { recipientPublicKeyB64: key.publicKeyB64, deviceLabel: 'Bob phone', deviceKind: 'mobile' }
    expect((await t.req(t.bob, 'POST', `/v1/team/workspaces/${t.id}/grants`, body)).status).toBe(404)
    await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${t.id}`, { visibility: 'team' })
    await t.req(t.alice, 'POST', `/v1/sandboxes/${t.id}/suspend`)
    const res = await t.req(t.bob, 'POST', `/v1/team/workspaces/${t.id}/grants`, body)
    expect(res.status).toBe(200)
    expect((await openSealedGrant(res.body.sealed, res.body.grant.id, key.secretKey, nodeSealedGrantPrimitives)).scope).toBe('mobile')
    expect((await t.req(t.bob, 'GET', `/v1/team/workspaces/${t.id}`)).body.workspace).toMatchObject({ status: 'running', access: 'granted' })
  })

  it('revokes in the VM at once, and on going private, and queues revokes while suspended', async () => {
    const t = await team()
    await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${t.id}`, { visibility: 'team' })
    const grant = async (bearer: typeof t.bob, label: string) =>
      (await t.req(bearer, 'POST', `/v1/team/workspaces/${t.id}/grants`, { recipientPublicKeyB64: generateGrantRecipientKey().publicKeyB64, deviceLabel: label, deviceKind: 'desktop' })).body.grant
    const g1 = await grant(t.bob, 'one')
    const g2 = await grant(t.bob, 'two')
    const box = [...t.h.vercel.boxes.values()][0]!
    expect(box.devices).toHaveLength(3)

    const del = await t.req(t.bob, 'DELETE', `/v1/team/workspaces/${t.id}/grants/${g1.id}`)
    expect(del.body).toMatchObject({ revoked: 1, queued: 0, grant: { status: 'revoked' } })
    expect(box.devices).toHaveLength(2)

    // Suspended: the revoke is queued and applied at the next boot, before orcad starts.
    await t.req(t.alice, 'POST', `/v1/sandboxes/${t.id}/suspend`)
    const priv = await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${t.id}`, { visibility: 'private' })
    expect(priv.body.revoked).toEqual({ revoked: 0, queued: 1 })
    t.h.vercel.commands.length = 0
    await t.req(t.alice, 'POST', `/v1/sandboxes/${t.id}/resume`)
    const order = t.h.vercel.commands.map((c) => c.command)
    expect(order.indexOf(REVOKE_COMMAND)).toBeGreaterThanOrEqual(0)
    expect(order.indexOf(REVOKE_COMMAND)).toBeLessThan(order.lastIndexOf('/opt/orca/bin/orca-sandbox-start'))
    expect(box.devices).toEqual([`dev-owner-${box.params.name}`])
    const statuses = t.h.raw.prepare('SELECT id, status FROM workspace_grants ORDER BY created_at').all() as { id: string; status: string }[]
    expect(statuses.find((s) => s.id === g2.id)!.status).toBe('revoked')
    // Bob's device list is empty; the owner's own device stays.
    expect((await t.req(t.alice, 'GET', `/v1/team/workspaces/${t.id}/grants`)).body.grants.map((g: { deviceLabel: string }) => g.deviceLabel)).toEqual(['Owner desktop'])
  })

  it('reassigning the owner revokes the previous owner devices and moves the lifecycle API', async () => {
    const t = await team()
    expect((await t.req(t.bob, 'PATCH', `/v1/team/workspaces/${t.id}`, { ownerUserId: 'bob' })).status).toBe(404)
    const moved = await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${t.id}`, { ownerUserId: 'bob' })
    expect(moved.body.workspace).toMatchObject({ ownerUserId: 'bob', createdBy: 'alice', status: 'suspended' })
    expect(moved.body.workspace.ownershipTransferredAt).toEqual(expect.any(Number))
    // OWNER-TRANSFER: the hand-off stops the VM, so the previous owner's devices are revoked
    // at its next boot (queued), before orcad starts, instead of inside a VM that kept running.
    expect(moved.body.revoked).toEqual({ revoked: 0, queued: 1 })
    expect((await t.req(t.alice, 'POST', `/v1/sandboxes/${t.id}/resume`)).status).toBe(404)
    t.h.vercel.commands.length = 0
    expect((await t.req(t.bob, 'POST', `/v1/sandboxes/${t.id}/resume`)).status).toBe(200)
    const order = t.h.vercel.commands.map((c) => c.command)
    expect(order.indexOf(REVOKE_COMMAND)).toBeGreaterThanOrEqual(0)
    expect(order.indexOf(REVOKE_COMMAND)).toBeLessThan(order.lastIndexOf('/opt/orca/bin/orca-sandbox-start'))
    expect((await t.req(t.bob, 'POST', `/v1/sandboxes/${t.id}/suspend`)).status).toBe(200)
  })

  it('revokes a removed member everywhere (auth push)', async () => {
    const t = await team()
    t.h.env.OPERATOR_TOKEN = 'o'.repeat(40)
    await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${t.id}`, { visibility: 'team' })
    await t.req(t.bob, 'POST', `/v1/team/workspaces/${t.id}/grants`, { recipientPublicKeyB64: generateGrantRecipientKey().publicKeyB64, deviceLabel: 'b', deviceKind: 'desktop' })
    const res = await t.h.call('POST', '/v1/internal/org-members/removed', { bearer: 'o'.repeat(40), body: { accountId: 'org:acme', userId: 'bob' } })
    expect(res.body).toEqual({ revoked: 1, queued: 0, keysRevoked: 0, devicesRevoked: 0, grantsRevoked: 1, grantsQueued: 0, routinesDisabled: 0, readerKeysRevoked: 0 })
  })
})

describe('team wake (phones)', () => {
  it('a teammate wakes a team workspace with the single-flight wake, never learns the endpoint, billed to the team', async () => {
    const t = await team()
    await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${t.id}`, { visibility: 'team' })
    await t.req(t.alice, 'POST', `/v1/sandboxes/${t.id}/suspend`)
    const checksBefore = t.h.billing.checks.length
    const woke = await t.req(t.bob, 'POST', `/v1/team/workspaces/${t.id}/wake?wait=30s`)
    expect(woke.status).toBe(200)
    expect(HostedWakeResponseSchema.parse(woke.body)).toMatchObject({ state: 'ready', endpoint: null, sandboxId: t.id })
    // The same start check as the owner's own wake: the team's account pays.
    expect(t.h.billing.checks.slice(checksBefore)).toEqual([expect.objectContaining({ accountId: 'org:acme' })])
    // Racing wakes from teammate and owner start the VM once.
    await t.req(t.alice, 'POST', `/v1/sandboxes/${t.id}/suspend`)
    const answers = await Promise.all([
      t.req(t.bob, 'POST', `/v1/team/workspaces/${t.id}/wake?wait=30s`),
      t.req(t.alice, 'POST', `/v1/sandboxes/${t.id}/wake?wait=30s`)
    ])
    expect(answers.map((a) => a.body.state)).toEqual(['ready', 'ready'])
  })

  it('is not found for a non-member, for a private workspace, and for an archived one', async () => {
    const t = await team()
    await t.req(t.alice, 'POST', `/v1/sandboxes/${t.id}/suspend`)
    // Private (the default): teammates cannot wake it.
    expect((await t.req(t.bob, 'POST', `/v1/team/workspaces/${t.id}/wake?wait=1s`)).status).toBe(404)
    await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${t.id}`, { visibility: 'team' })
    const outsider = await t.as('mallory', 'member', 'globex')
    expect((await t.req(outsider, 'POST', `/v1/team/workspaces/${t.id}/wake?wait=1s`)).status).toBe(404)
    await t.req(t.alice, 'POST', `/v1/sandboxes/${t.id}/archive`, {})
    expect((await t.req(t.bob, 'POST', `/v1/team/workspaces/${t.id}/wake?wait=1s`)).status).toBe(404)
  })

  it('an org admin cannot wake a private workspace, and a running one never hands a teammate its endpoint', async () => {
    const t = await team()
    expect((await t.req(t.admin, 'POST', `/v1/team/workspaces/${t.id}/wake?wait=1s`)).status).toBe(404)
    await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${t.id}`, { visibility: 'team' })
    const running = await t.req(t.bob, 'POST', `/v1/team/workspaces/${t.id}/wake?wait=1s`)
    expect(running.body).toMatchObject({ state: 'ready', endpoint: null })
  })

  it('keeps the desktop blocking wake (no wait) answering {workspace}', async () => {
    const t = await team()
    await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${t.id}`, { visibility: 'team' })
    await t.req(t.alice, 'POST', `/v1/sandboxes/${t.id}/suspend`)
    const woke = await t.req(t.bob, 'POST', `/v1/team/workspaces/${t.id}/wake`)
    expect(woke.body.workspace).toMatchObject({ id: t.id, status: 'running' })
  })
})

describe('grant races', () => {
  it('a removal that lands while the grant is being issued wins: the new device is killed, not activated', async () => {
    const t = await team()
    await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${t.id}`, { visibility: 'team' })
    const box = [...t.h.vercel.boxes.values()][0]!
    t.h.vercel.commandHandler = (params) => {
      if (params.command === GRANT_COMMAND) {
        // The concurrent revoke sees an `issuing` row with no device id yet: nothing to kill on the VM.
        t.h.raw.prepare(`UPDATE workspace_grants SET status = 'revoked', revoked_by = 'system', revoke_reason = 'member_removed' WHERE status = 'issuing'`).run()
      }
      return undefined
    }
    const res = await t.req(t.bob, 'POST', `/v1/team/workspaces/${t.id}/grants`, { recipientPublicKeyB64: generateGrantRecipientKey().publicKeyB64, deviceLabel: 'b', deviceKind: 'desktop' })
    expect(res.status).toBe(404)
    const rows = t.h.raw.prepare(`SELECT status, revoke_reason, orcad_device_id FROM workspace_grants WHERE user_id = 'bob'`).all() as { status: string; revoke_reason: string; orcad_device_id: string }[]
    expect(rows).toEqual([{ status: 'revoked', revoke_reason: 'member_removed', orcad_device_id: expect.stringMatching(/^dev-grant/) }])
    expect(box.devices).not.toContain(rows[0]!.orcad_device_id)
  })
})

describe('VM sealer interop', () => {
  it('the sealer embedded in orca-sandbox-grant opens with the shared portable opener', async () => {
    const script = readFileSync(fileURLToPath(new URL('../image/vm/orca-sandbox-grant', import.meta.url).href), 'utf8')
    const sealer = /"\$node" -e '([\s\S]+)'\n?$/.exec(script.trimEnd())![1]!
    const key = generateGrantRecipientKey()
    const offer = { result: { available: true, scope: 'runtime', pairingUrl: 'orca://pair?code=abc', deviceId: 'dev-7' } }
    const out = execFileSync(process.execPath, ['-e', sealer], {
      input: JSON.stringify(offer),
      env: { ORCA_GRANT_ID: 'grt_x', ORCA_GRANT_RECIPIENT_KEY: key.publicKeyB64 }
    }).toString()
    const parsed = JSON.parse(out)
    expect(parsed.deviceId).toBe('dev-7')
    expect(out).not.toContain('orca://pair')
    expect(await openSealedGrant(parsed.sealed, 'grt_x', key.secretKey, nodeSealedGrantPrimitives)).toEqual({
      pairingUrl: 'orca://pair?code=abc',
      deviceId: 'dev-7',
      scope: 'runtime'
    })
  })
})

describe('desktop wire contract', () => {
  it('every registry response parses with the desktop schemas', async () => {
    const wire = await import('../../../../src/shared/cloud-workspaces/cloud-workspaces-wire')
    const t = await team()
    await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${t.id}`, { visibility: 'team' })
    wire.CloudWorkspaceListResponseSchema.parse((await t.req(t.bob, 'GET', '/v1/team/workspaces')).body)
    wire.CloudWorkspaceResponseSchema.parse((await t.req(t.bob, 'GET', `/v1/team/workspaces/${t.id}`)).body)
    wire.CloudWorkspacePresenceResponseSchema.parse(
      (await t.req(t.bob, 'POST', `/v1/team/workspaces/${t.id}/presence`, { clientId: 'c', state: 'viewing' })).body
    )
    wire.CloudWorkspaceLinkResponseSchema.parse((await t.req(t.bob, 'GET', `/v1/team/links/resolve?w=${t.id}`)).body)
    const issued = wire.CloudWorkspaceGrantIssuedSchema.parse(
      (
        await t.req(t.bob, 'POST', `/v1/team/workspaces/${t.id}/grants`, {
          recipientPublicKeyB64: generateGrantRecipientKey().publicKeyB64,
          deviceLabel: 'x',
          deviceKind: 'desktop'
        })
      ).body
    )
    wire.CloudWorkspaceGrantListSchema.parse((await t.req(t.bob, 'GET', `/v1/team/workspaces/${t.id}/grants`)).body)
    expect(wire.parseCloudWorkspaceLink(wire.cloudWorkspaceLink(t.id, 'chat 1'))).toEqual({ target: { kind: 'id', workspaceId: t.id }, chatId: 'chat 1' })
    expect(issued.grant.status).toBe('active')
  })

  it('syncs org prompts: admins write with compare-and-set, members read', async () => {
    const wire = await import('../../../../src/shared/cloud-workspaces/cloud-workspaces-wire')
    const t = await team()
    const doc = { prompts: [{ id: 'review', name: 'Review', body: 'Review this PR' }], prInstructions: 'Link the Linear issue.' }
    const put = await t.req(t.admin, 'PUT', '/v1/team/prompts', { revision: 0, document: doc })
    expect(wire.OrgPromptsSchema.parse(put.body).revision).toBe(1)
    expect((await t.req(t.bob, 'PUT', '/v1/team/prompts', { revision: 1, document: doc })).status).toBe(403)
    expect((await t.req(t.admin, 'PUT', '/v1/team/prompts', { revision: 0, document: doc })).body.reason).toBe('stale_revision')
    expect(wire.OrgPromptsSchema.parse((await t.req(t.bob, 'GET', '/v1/team/prompts')).body).document).toEqual(doc)
  })
})
