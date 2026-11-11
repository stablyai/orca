import { describe, expect, it } from 'vitest'
import { usageLevel } from '../src/team-presence'
import { createHarness } from './harness'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

async function team() {
  const h = await createHarness({ OPERATOR_TOKEN: 'o'.repeat(40) })
  type Who = { sub: string; orgRole: 'owner' | 'admin' | 'member'; org?: string; name?: string }
  const req = async (who: Who, method: string, path: string, body?: unknown) =>
    h.call(method, path, {
      bearer: await h.token(who.sub, who.org === undefined ? 'acme' : who.org || undefined, 'sandbox', {
        org_role: who.orgRole,
        ...(who.name ? { name: who.name } : {})
      }),
      body
    })
  const alice: Who = { sub: 'alice', orgRole: 'member', name: 'Alice Doe' }
  const bob: Who = { sub: 'bob', orgRole: 'member', name: 'Bob Roe' }
  return { h, req, alice, bob }
}

describe('teammate profiles', () => {
  it('shows a teammate only their team workspaces and a 0–4 heatmap, never amounts', async () => {
    const t = await team()
    const shared = await t.req(t.alice, 'POST', '/v1/sandboxes', { workspaceId: 'ws-1', machineSize: 'standard', title: 'Shared' })
    const secret = await t.req(t.alice, 'POST', '/v1/sandboxes', { workspaceId: 'ws-2', machineSize: 'standard', title: 'Secret' })
    expect(shared.status).toBe(200)
    const sharedId = shared.body.sandbox.id as string
    const secretId = secret.body.sandbox.id as string
    await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${sharedId}`, { visibility: 'team' })
    const now = t.h.now()
    // Two hours of sandbox time yesterday on the private one, half an hour today on the shared one.
    const outbox = t.h.raw.prepare(
      `INSERT INTO usage_outbox (usage_id, sandbox_id, account_id, machine_size, started_at, ended_at) VALUES (?, ?, ?, 'standard', ?, ?)`
    )
    const accountId = (t.h.raw.prepare('SELECT account_id FROM sandboxes WHERE id = ?').get(sharedId) as { account_id: string }).account_id
    outbox.run('u1', secretId, accountId, now - DAY - 2 * HOUR, now - DAY)
    outbox.run('u2', sharedId, accountId, now - 30 * MIN, now)

    // Not shared until Alice turns on "Pokes and activity"; workspaces she shared still show.
    const hidden = (await t.req(t.bob, 'GET', '/v1/team/members/alice/profile?utcOffsetMin=0')).body.profile
    expect(hidden).toMatchObject({ usage: null, pokes: { enabled: false, teammateEnabled: false } })
    expect(hidden.recentWorkspaces).toHaveLength(1)
    await t.req(t.alice, 'PUT', '/v1/team/pokes/settings', { enabled: true })

    const seen = await t.req(t.bob, 'GET', '/v1/team/members/alice/profile?utcOffsetMin=0')
    expect(seen.status).toBe(200)
    const profile = seen.body.profile
    expect(profile).toMatchObject({ userId: 'alice', self: false, name: 'Alice Doe', pokes: { enabled: false, teammateEnabled: true } })
    expect(profile.recentWorkspaces.map((w: { id: string }) => w.id)).toEqual([sharedId])
    expect(profile.usage.own).toBeNull()
    expect(profile.usage.levels).toHaveLength(182)
    expect(profile.usage.activeDays).toBe(2)
    // Relative to her own busiest day: yesterday is the max (4), today a quarter of it (1).
    expect(profile.usage.levels.slice(-2)).toEqual([4, 1])
    expect(JSON.stringify(profile.usage)).not.toMatch(/usdMicros|computeMs/)

    const own = await t.req(t.alice, 'GET', '/v1/team/members/alice/profile?utcOffsetMin=0')
    expect(own.body.profile.self).toBe(true)
    expect(own.body.profile.recentWorkspaces).toHaveLength(2)
    expect(own.body.profile.usage.own.computeMs.slice(-2)).toEqual([2 * HOUR, 30 * MIN])
    expect(own.body.profile.usage.own.usdMicros.at(-1)).toBeGreaterThan(0)
  })

  it('splits a session across local midnight and dates reported model spend', async () => {
    const t = await team()
    const created = await t.req(t.alice, 'POST', '/v1/sandboxes', { workspaceId: 'ws-1', machineSize: 'standard' })
    const id = created.body.sandbox.id as string
    const now = t.h.now()
    const accountId = (t.h.raw.prepare('SELECT account_id FROM sandboxes WHERE id = ?').get(id) as { account_id: string }).account_id
    const midnight = Math.floor(now / DAY) * DAY
    t.h.raw
      .prepare(`INSERT INTO usage_outbox (usage_id, sandbox_id, account_id, machine_size, started_at, ended_at) VALUES ('u1', ?, ?, 'standard', ?, ?)`)
      .run(id, accountId, midnight - HOUR, midnight + HOUR)
    expect((await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${id}`, { tokenUsdMicros: 500_000 })).status).toBe(200)
    expect((await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${id}`, { tokenUsdMicros: 400_000 })).status).toBe(200)
    expect((await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${id}`, { tokenUsdMicros: 700_000 })).status).toBe(200)
    const own = (await t.req(t.alice, 'GET', '/v1/team/members/alice/profile?utcOffsetMin=0')).body.profile.usage.own
    const today = own.computeMs.length - 1
    const tokenAndCompute = own.usdMicros[today]
    expect(own.computeMs[today - 1]).toBe(HOUR)
    // Only increases count: 500k, then nothing for the drop to 400k, then 300k more.
    expect(tokenAndCompute - own.usdMicros[today - 1]).toBe(500_000 + 300_000)
  })

  it('shares every teammate\'s activity when the account config says team', async () => {
    const h = await createHarness({ TEAMMATE_ACTIVITY_SHARING: 'team' })
    const bob = await h.token('bob', 'acme', 'sandbox', { org_role: 'member' })
    const seen = await h.call('GET', '/v1/team/members/alice/profile', { bearer: bob })
    expect(seen.body.profile.usage.levels).toHaveLength(182)
    expect(seen.body.profile.usage.own).toBeNull()
  })

  it('keeps personal accounts to themselves and rejects bad ids', async () => {
    const t = await team()
    const solo = { sub: 'solo', orgRole: 'owner' as const, org: '' }
    expect((await t.req(solo, 'GET', '/v1/team/members/alice/profile')).status).toBe(404)
    expect((await t.req(solo, 'GET', '/v1/team/members/solo/profile')).status).toBe(200)
    expect((await t.req(t.bob, 'GET', '/v1/team/members/a%20b/profile')).status).toBe(400)
    const stranger = { sub: 'eve', orgRole: 'owner' as const, org: 'other' }
    expect((await t.req(stranger, 'GET', '/v1/team/members/alice/profile')).body.profile.recentWorkspaces).toEqual([])
  })

  it('levels are relative to the busiest day', () => {
    expect([0, 1, 25, 26, 50, 100].map((v) => usageLevel(v, 100))).toEqual([0, 1, 1, 2, 2, 4])
    expect(usageLevel(5, 0)).toBe(0)
  })
})

describe('pokes', () => {
  it('needs both people opted in, then delivers, rate-limits and acks', async () => {
    const t = await team()
    expect(await t.req(t.alice, 'POST', '/v1/team/members/bob/poke')).toMatchObject({ status: 409, body: { reason: 'pokes_off' } })
    expect((await t.req(t.alice, 'PUT', '/v1/team/pokes/settings', { enabled: true })).body).toEqual({ enabled: true })
    expect(await t.req(t.alice, 'POST', '/v1/team/members/bob/poke')).toMatchObject({ status: 409, body: { reason: 'teammate_pokes_off' } })
    const before = (await t.req(t.alice, 'GET', '/v1/team/members/bob/profile')).body.profile.pokes
    expect(before).toEqual({ enabled: true, teammateEnabled: false })
    await t.req(t.bob, 'PUT', '/v1/team/pokes/settings', { enabled: true })
    expect((await t.req(t.alice, 'GET', '/v1/team/members/bob/profile')).body.profile.pokes.teammateEnabled).toBe(true)

    const sent = await t.req(t.alice, 'POST', '/v1/team/members/bob/poke')
    expect(sent.status).toBe(200)
    const again = await t.req(t.alice, 'POST', '/v1/team/members/bob/poke')
    expect(again).toMatchObject({ status: 429, body: { reason: 'poke_cooldown' } })
    expect(again.body.retryAfterMs).toBeGreaterThan(0)
    expect(await t.req(t.alice, 'POST', '/v1/team/members/alice/poke')).toMatchObject({ status: 400, body: { reason: 'self' } })

    const inbox = await t.req(t.bob, 'GET', '/v1/team/pokes')
    expect(inbox.body.enabled).toBe(true)
    expect(inbox.body.pokes).toEqual([{ id: sent.body.poke.id, fromUserId: 'alice', fromName: 'Alice Doe', at: t.h.now() }])
    // Alice sees nothing addressed to her; another org sees nothing at all.
    expect((await t.req(t.alice, 'GET', '/v1/team/pokes')).body.pokes).toEqual([])
    expect((await t.req({ sub: 'bob', orgRole: 'member', org: 'other' }, 'GET', '/v1/team/pokes')).body.pokes).toEqual([])

    expect((await t.req(t.bob, 'POST', '/v1/team/pokes/seen', { ids: [sent.body.poke.id] })).status).toBe(200)
    expect((await t.req(t.bob, 'GET', '/v1/team/pokes')).body.pokes).toEqual([])

    // Poke back works, and after the cooldown Alice may poke again.
    expect((await t.req(t.bob, 'POST', '/v1/team/members/alice/poke')).status).toBe(200)
    t.h.advance(61_000)
    expect((await t.req(t.alice, 'POST', '/v1/team/members/bob/poke')).status).toBe(200)
  })

  it('caps pokes per sender per hour and drops stale or opted-out ones', async () => {
    const t = await team()
    await t.req(t.alice, 'PUT', '/v1/team/pokes/settings', { enabled: true })
    const teammates = Array.from({ length: 21 }, (_, i) => ({ sub: `m${i}`, orgRole: 'member' as const }))
    for (const m of teammates) {
      await t.req(m, 'PUT', '/v1/team/pokes/settings', { enabled: true })
    }
    for (const m of teammates.slice(0, 20)) {
      expect((await t.req(t.alice, 'POST', `/v1/team/members/${m.sub}/poke`)).status).toBe(200)
    }
    expect(await t.req(t.alice, 'POST', '/v1/team/members/m20/poke')).toMatchObject({ status: 429, body: { reason: 'poke_rate' } })
    // Turning Pokes off clears what was waiting; a day-old poke is never shown.
    expect((await t.req(teammates[0]!, 'GET', '/v1/team/pokes')).body.pokes).toHaveLength(1)
    await t.req(teammates[0]!, 'PUT', '/v1/team/pokes/settings', { enabled: false })
    await t.req(teammates[0]!, 'PUT', '/v1/team/pokes/settings', { enabled: true })
    expect((await t.req(teammates[0]!, 'GET', '/v1/team/pokes')).body.pokes).toEqual([])
    t.h.advance(DAY + MIN)
    expect((await t.req(teammates[1]!, 'GET', '/v1/team/pokes')).body.pokes).toEqual([])
  })

  it('forgets a removed member so nobody can poke them', async () => {
    const t = await team()
    await t.req(t.alice, 'PUT', '/v1/team/pokes/settings', { enabled: true })
    await t.req(t.bob, 'PUT', '/v1/team/pokes/settings', { enabled: true })
    const removed = await t.h.call('POST', '/v1/internal/org-members/removed', { bearer: 'o'.repeat(40), body: { accountId: 'org:acme', userId: 'bob' } })
    expect(removed.status).toBe(200)
    expect(await t.req(t.alice, 'POST', '/v1/team/members/bob/poke')).toMatchObject({ status: 409, body: { reason: 'teammate_pokes_off' } })
  })

  it('refuses Pokes on a personal account', async () => {
    const t = await team()
    const solo = { sub: 'solo', orgRole: 'owner' as const, org: '' }
    expect(await t.req(solo, 'PUT', '/v1/team/pokes/settings', { enabled: true })).toMatchObject({ status: 400, body: { reason: 'personal_account' } })
    expect((await t.req(solo, 'GET', '/v1/team/pokes')).body).toEqual({ enabled: false, pokes: [] })
  })
})

describe('member-removed token', () => {
  it('authorizes only POST /v1/internal/org-members/removed, never other operator routes', async () => {
    const MR = 'm'.repeat(40)
    const body = { accountId: 'org:acme', userId: 'bob' }
    const h = await createHarness({ OPERATOR_TOKEN: 'o'.repeat(40), MEMBER_REMOVED_TOKEN: MR })
    expect((await h.call('POST', '/v1/internal/org-members/removed', { bearer: MR, body })).status).toBe(200)
    expect((await h.call('GET', '/v1/internal/status', { bearer: MR })).status).toBe(404)
    expect((await h.call('POST', '/v1/internal/members/removed', { bearer: MR, body })).status).toBe(404)
    // The operator token still works on the route; a short token is never accepted.
    expect((await h.call('POST', '/v1/internal/org-members/removed', { bearer: 'o'.repeat(40), body })).status).toBe(200)
    const weak = await createHarness({ OPERATOR_TOKEN: 'o'.repeat(40), MEMBER_REMOVED_TOKEN: 'short' })
    expect((await weak.call('POST', '/v1/internal/org-members/removed', { bearer: 'short', body })).status).toBe(404)
  })
})
