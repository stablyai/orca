import { describe, expect, it } from 'vitest'
import { createHarness } from './harness'

// TEAM-DELETE: auth asks how many cloud workspaces a team still has, then purges its cloud secrets.
const AUTH = 'a'.repeat(40)
const OPERATOR = 'o'.repeat(40)

async function setup() {
  const h = await createHarness({ MEMBER_REMOVED_TOKEN: AUTH, OPERATOR_TOKEN: OPERATOR })
  const sandbox = (id: string, accountId: string, status: string) =>
    h.env.SANDBOX_DB.prepare(
      `INSERT INTO sandboxes (id, account_id, user_id, workspace_id, provider, provider_name, status, machine_size, region, generation, created_at, updated_at)
       VALUES (?, ?, 'mia', ?, 'vercel', ?, ?, 'standard', 'iad1', 0, 1, 1)`
    )
      .bind(id, accountId, `ws-${id}`, `orca-test-${id}`, status)
      .run()
  const secret = (scope: string, ownerId: string, name: string) =>
    h.env.SANDBOX_DB.prepare(
      `INSERT INTO secrets (scope, owner_id, name, kek_id, wrapped_dek, ciphertext, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, 'k', 'w', 'c', 1, 1, 'mia')`
    )
      .bind(scope, ownerId, name)
      .run()
  const secrets = () =>
    h.raw.prepare('SELECT scope, owner_id, name FROM secrets ORDER BY scope, owner_id, name').all()
  return { h, sandbox, secret, secrets }
}

describe('team delete internal routes', () => {
  it('counts the team’s workspaces in every state but destroyed', async () => {
    const { h, sandbox } = await setup()
    await sandbox('a', 'org:acme', 'running')
    await sandbox('b', 'org:acme', 'suspended')
    await sandbox('c', 'org:acme', 'archived')
    await sandbox('d', 'org:acme', 'destroyed')
    await sandbox('e', 'org:other', 'running')
    const check = await h.call('GET', '/v1/internal/accounts/org:acme/delete-check', { bearer: AUTH })
    expect(check).toEqual({ status: 200, body: { workspaces: 3 } })
    const none = await h.call('GET', '/v1/internal/accounts/org:empty/delete-check', { bearer: AUTH })
    expect(none.body).toEqual({ workspaces: 0 })
  })

  it('purges only the team’s org and repo secrets, and only once no workspace is left', async () => {
    const { h, sandbox, secret, secrets } = await setup()
    await secret('org', 'org:acme', 'NPM_TOKEN')
    await secret('repo', 'org:acme#github.com/acme/web', 'DB_URL')
    await secret('org', 'org:acme2', 'KEEP_SIMILAR_PREFIX')
    await secret('repo', 'org:acme2#github.com/acme2/web', 'KEEP_TOO')
    await secret('personal', 'user:mia', 'ANTHROPIC_API_KEY')
    await sandbox('a', 'org:acme', 'suspended')

    const blocked = await h.call('POST', '/v1/internal/accounts/org:acme/secrets/purge', { bearer: AUTH })
    expect(blocked).toEqual({ status: 409, body: { error: 'workspaces_exist', workspaces: 1 } })
    expect(secrets()).toHaveLength(5)

    await h.env.SANDBOX_DB.prepare(`UPDATE sandboxes SET status = 'destroyed' WHERE id = 'a'`).run()
    const purged = await h.call('POST', '/v1/internal/accounts/org:acme/secrets/purge', { bearer: AUTH })
    expect(purged.status).toBe(200)
    expect(secrets()).toEqual([
      { scope: 'org', owner_id: 'org:acme2', name: 'KEEP_SIMILAR_PREFIX' },
      { scope: 'personal', owner_id: 'user:mia', name: 'ANTHROPIC_API_KEY' },
      { scope: 'repo', owner_id: 'org:acme2#github.com/acme2/web', name: 'KEEP_TOO' }
    ])
  })

  it('needs auth’s token, never a desktop token, and answers only its own paths and methods', async () => {
    const { h } = await setup()
    expect((await h.call('GET', '/v1/internal/accounts/org:acme/delete-check')).status).toBe(404)
    expect((await h.call('GET', '/v1/internal/accounts/org:acme/delete-check', { bearer: 'x'.repeat(40) })).status).toBe(
      404
    )
    // A personal account is not a team.
    expect((await h.call('GET', '/v1/internal/accounts/user:mia/delete-check', { bearer: AUTH })).status).toBe(404)
    expect((await h.call('POST', '/v1/internal/accounts/org:acme/delete-check', { bearer: AUTH })).status).toBe(404)
    // Auth's token still opens no operator route.
    expect((await h.call('GET', '/v1/internal/suspensions', { bearer: AUTH })).status).toBe(404)
  })
})
