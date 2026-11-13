// ORG-TOKEN-STALE (Worker backstop): the desktop names the team it is acting for (`x-orca-org`), and a token
// minted for another team is refused with 409 org_mismatch instead of acting on the wrong team. A token minted
// before a role change is refused (401 stale_token) where it would create, read secrets, or reach GitHub.
import { describe, expect, it } from 'vitest'
import { recordMemberChange } from '../src/member-changes'
import { createHarness } from './harness'

async function setup() {
  const h = await createHarness({ SECRETS_KEK: Buffer.alloc(32, 7).toString('base64') })
  const teamToken = await h.token('alice', 'acme', 'sandbox', { org_role: 'admin' })
  const personalToken = await h.token('alice')
  return { h, teamToken, personalToken }
}

describe('x-orca-org: a token for another team is refused', () => {
  it('no header: no check (older desktops)', async () => {
    const { h, teamToken } = await setup()
    const res = await h.call('GET', '/v1/sandboxes', { bearer: teamToken })
    expect(res.status).toBe(200)
  })

  it('header matching the token’s org passes', async () => {
    const { h, teamToken } = await setup()
    const res = await h.call('GET', '/v1/sandboxes', { bearer: teamToken, headers: { 'x-orca-org': 'acme' } })
    expect(res.status).toBe(200)
  })

  it('header naming another team: 409 org_mismatch, nothing acted on', async () => {
    const { h, teamToken } = await setup()
    const list = await h.call('GET', '/v1/sandboxes', { bearer: teamToken, headers: { 'x-orca-org': 'other-team' } })
    expect(list.status).toBe(409)
    expect(list.body).toMatchObject({ error: 'org_mismatch', reason: 'org_mismatch' })
    const create = await h.call('POST', '/v1/sandboxes', {
      bearer: teamToken,
      headers: { 'x-orca-org': 'other-team' },
      body: { workspaceId: 'ws-1', machineSize: 'standard' }
    })
    expect(create.status).toBe(409)
    const after = await h.call('GET', '/v1/sandboxes', { bearer: teamToken, headers: { 'x-orca-org': 'acme' } })
    expect(after.body.sandboxes).toHaveLength(0)
  })

  it('`user` (personal) with a team token, or a team header with a personal token: 409', async () => {
    const { h, teamToken, personalToken } = await setup()
    expect((await h.call('GET', '/v1/sandboxes', { bearer: teamToken, headers: { 'x-orca-org': 'user' } })).status).toBe(409)
    expect((await h.call('GET', '/v1/sandboxes', { bearer: personalToken, headers: { 'x-orca-org': 'acme' } })).status).toBe(409)
    expect((await h.call('GET', '/v1/sandboxes', { bearer: personalToken, headers: { 'x-orca-org': 'user' } })).status).toBe(200)
  })

  it('secrets and GitHub routes are covered too', async () => {
    const { h, teamToken } = await setup()
    const headers = { 'x-orca-org': 'other-team' }
    expect((await h.call('GET', '/v1/secrets', { bearer: teamToken, headers })).status).toBe(409)
    expect((await h.call('GET', '/v1/github/repositories', { bearer: teamToken, headers })).status).toBe(409)
  })
})

describe('a token minted before a role change: 401 stale_token where it matters', () => {
  it('create, secrets and GitHub refuse it; a fresh token works', async () => {
    const { h, teamToken } = await setup()
    h.advance(2_000)
    await recordMemberChange(h.env.SANDBOX_DB, 'org:acme', 'alice', 'role', h.now())
    const create = await h.call('POST', '/v1/sandboxes', { bearer: teamToken, body: { workspaceId: 'ws-2', machineSize: 'standard' } })
    expect(create.status).toBe(401)
    expect(create.body).toMatchObject({ reason: 'stale_token' })
    expect((await h.call('GET', '/v1/secrets', { bearer: teamToken })).body).toMatchObject({ reason: 'stale_token' })
    expect((await h.call('GET', '/v1/github/repositories', { bearer: teamToken })).body).toMatchObject({ reason: 'stale_token' })
    h.advance(2_000)
    const fresh = await h.token('alice', 'acme', 'sandbox', { org_role: 'member' })
    expect((await h.call('GET', '/v1/secrets', { bearer: fresh })).body.reason).not.toBe('stale_token')
  })
})
