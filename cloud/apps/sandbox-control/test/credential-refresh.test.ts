// The central refresher (GitHub user tokens under a lease), the push outbox, expiry pushes and
// the scheduled Claude revocation checks. Pure modules over the fake D1; no Worker harness.
import { describe, expect, it, vi } from 'vitest'
import { putAgentCredential } from '../src/agent-credentials'
import { runScheduledAccountChecks, SCHEDULED_CHECK_EVERY_MS, SUSPECT_RECHECK_MS } from '../src/agent-credential-checks'
import { claudeAccount } from '../src/account-providers'
import { markCredentialChanged, pushCredentialChange, pushPendingCredentialChanges, credentialPushTargets, type PushDeps } from '../src/credential-outbox'
import { GITHUB_USER_REFRESH_AHEAD_MS, markExpiredAccountCredentials, refreshGitHubUserTokens } from '../src/credential-refresh'
import type { GitHubConnectConfig } from '../src/github-connect'
import { memberGitIdentity, refreshGitHubUserToken, storeUserToken } from '../src/github-user-tokens'
import { createKeyring, type Keyring } from '../src/secrets-crypto'
import { createFakeD1 } from './d1-fake'

const KEK = Buffer.alloc(32, 7).toString('base64')
const HOUR = 60 * 60_000
const T0 = 1_800_000_000_000

async function setup() {
  const { db } = createFakeD1()
  const keyring: Keyring = await createKeyring({ id: 'k1', key: KEK })
  let clock = T0
  const now = () => clock
  const sandbox = async (id: string, userId: string, status = 'running', accountId = `user:${userId}`) =>
    db
      .prepare(
        `INSERT INTO sandboxes (id, account_id, user_id, workspace_id, provider, provider_name, status, machine_size, region, generation, created_at, updated_at, repo_url, session_id)
         VALUES (?, ?, ?, ?, 'vercel', ?, ?, 'standard', 'iad1', 0, 1, 1, 'https://github.com/acme/app', ?)`
      )
      .bind(id, accountId, userId, `ws-${id}`, `orca-${id}`, status, `sess-${id}`)
      .run()
  return { db, keyring, now, advance: (ms: number) => (clock += ms), sandbox }
}

/** A GitHub OAuth endpoint double: counts refreshes, answers each with a new rotating pair (or `reply`). */
function githubOAuth() {
  let n = 0
  let reply: (() => Response) | null = null
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { refresh_token?: string }
    if (reply) {
      return reply()
    }
    n++
    return Response.json({
      access_token: `ghu_new_${n}`,
      refresh_token: `ghr_new_${n}`,
      expires_in: 8 * 3600,
      refresh_token_expires_in: 180 * 86400,
      spent: body.refresh_token
    })
  })
  const config: GitHubConnectConfig = { appSlug: 'orca', clientId: 'cid', clientSecret: 'secret', stateSecret: 's', fetch: fetch as unknown as typeof globalThis.fetch }
  return { fetch, config, setReply: (r: (() => Response) | null) => (reply = r) }
}

async function connectMember(ctx: Awaited<ReturnType<typeof setup>>, userId: string, accessLeftMs: number, accountId = `user:${userId}`) {
  await storeUserToken(
    ctx.db,
    ctx.keyring,
    { account_id: accountId, user_id: userId },
    { id: 42, login: userId, name: null },
    { access: 'ghu_old', refresh: 'ghr_old', accessExpiresAt: ctx.now() + accessLeftMs, refreshExpiresAt: ctx.now() + 100 * 86400_000 },
    ctx.now()
  )
}

const pending = (db: D1Database) =>
  db.prepare('SELECT kind, subject FROM credential_pushes WHERE pushed_at IS NULL OR pushed_at < changed_at ORDER BY kind, subject').all<{ kind: string; subject: string }>().then((r) => r.results)

describe('GitHub user tokens: central refresh under a lease', () => {
  it('refreshes a running member token an hour ahead, once, and records the change for its sandboxes', async () => {
    const ctx = await setup()
    const gh = githubOAuth()
    await ctx.sandbox('sbx_a', 'mia')
    await connectMember(ctx, 'mia', 50 * 60_000)
    await ctx.db.prepare('DELETE FROM credential_pushes').run()
    const summary = await refreshGitHubUserTokens({ db: ctx.db, keyring: ctx.keyring, config: gh.config, now: ctx.now })
    expect(summary).toMatchObject({ due: 1, refreshed: 1 })
    expect(gh.fetch).toHaveBeenCalledTimes(1)
    const identity = await memberGitIdentity(ctx.db, ctx.keyring, gh.config, 'user:mia', 'mia', ctx.now())
    expect(identity?.token).toBe('ghu_new_1')
    expect(await pending(ctx.db)).toEqual([{ kind: 'github_user', subject: 'user:mia#mia' }])
    // Not due again until an hour before the new expiry.
    expect((await refreshGitHubUserTokens({ db: ctx.db, keyring: ctx.keyring, config: gh.config, now: ctx.now })).due).toBe(0)
  })

  it('leaves tokens of members with no running workspace to the lazy path', async () => {
    const ctx = await setup()
    const gh = githubOAuth()
    await ctx.sandbox('sbx_a', 'mia', 'stopped')
    await connectMember(ctx, 'mia', 10 * 60_000)
    expect((await refreshGitHubUserTokens({ db: ctx.db, keyring: ctx.keyring, config: gh.config, now: ctx.now })).due).toBe(0)
    // The next boot or request refreshes it (same lease).
    expect((await memberGitIdentity(ctx.db, ctx.keyring, gh.config, 'user:mia', 'mia', ctx.now()))?.token).toBe('ghu_new_1')
  })

  it('spends a single-use refresh token once when the central and lazy paths race', async () => {
    const ctx = await setup()
    const gh = githubOAuth()
    await ctx.sandbox('sbx_a', 'mia')
    await connectMember(ctx, 'mia', 10 * 60_000)
    const deps = { db: ctx.db, keyring: ctx.keyring, config: gh.config, now: ctx.now }
    const outcomes = await Promise.all([
      refreshGitHubUserToken(deps, { account_id: 'user:mia', user_id: 'mia' }, { aheadMs: GITHUB_USER_REFRESH_AHEAD_MS }),
      refreshGitHubUserToken(deps, { account_id: 'user:mia', user_id: 'mia' }, { aheadMs: GITHUB_USER_REFRESH_AHEAD_MS }),
      memberGitIdentity(ctx.db, ctx.keyring, gh.config, 'user:mia', 'mia', ctx.now())
    ])
    expect(gh.fetch).toHaveBeenCalledTimes(1)
    expect(outcomes.slice(0, 2).sort()).toEqual(['refreshed', 'skipped'])
    // The lazy caller serves a valid token either way (the old one is still valid while the refresh runs).
    expect((outcomes[2] as { token: string }).token).toMatch(/^ghu_(old|new_1)$/)
  })

  it('a dead refresh token ends the connection: no retries, the identity leaves the sandboxes', async () => {
    const ctx = await setup()
    const gh = githubOAuth()
    await ctx.sandbox('sbx_a', 'mia')
    await connectMember(ctx, 'mia', 10 * 60_000)
    await ctx.db.prepare('DELETE FROM credential_pushes').run()
    gh.setReply(() => Response.json({ error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' }))
    const deps = { db: ctx.db, keyring: ctx.keyring, config: gh.config, now: ctx.now }
    expect(await refreshGitHubUserTokens(deps)).toMatchObject({ due: 1, dead: 1 })
    expect(await pending(ctx.db)).toEqual([{ kind: 'github_user', subject: 'user:mia#mia' }])
    ctx.advance(60 * 60_000)
    expect((await refreshGitHubUserTokens(deps)).due).toBe(0)
    expect(gh.fetch).toHaveBeenCalledTimes(1)
    // A new connection starts clean.
    gh.setReply(null)
    await connectMember(ctx, 'mia', 10 * 60_000)
    expect(await refreshGitHubUserTokens(deps)).toMatchObject({ due: 1, refreshed: 1 })
  })

  it('backs off a transient failure and keeps the current token serving', async () => {
    const ctx = await setup()
    const gh = githubOAuth()
    await ctx.sandbox('sbx_a', 'mia')
    await connectMember(ctx, 'mia', 50 * 60_000)
    gh.setReply(() => new Response('bad gateway', { status: 502 }))
    const deps = { db: ctx.db, keyring: ctx.keyring, config: gh.config, now: ctx.now }
    expect(await refreshGitHubUserTokens(deps)).toMatchObject({ due: 1, failed: 1 })
    expect((await refreshGitHubUserTokens(deps)).due).toBe(0)
    ctx.advance(61_000)
    gh.setReply(null)
    expect(await refreshGitHubUserTokens(deps)).toMatchObject({ due: 1, refreshed: 1 })
  })

  it('never overwrites a reconnection that landed during the refresh', async () => {
    const ctx = await setup()
    const gh = githubOAuth()
    await ctx.sandbox('sbx_a', 'mia')
    await connectMember(ctx, 'mia', 10 * 60_000)
    gh.fetch.mockImplementationOnce(async () => {
      // The member reconnects while GitHub answers the refresh.
      ctx.advance(1_000)
      await storeUserToken(ctx.db, ctx.keyring, { account_id: 'user:mia', user_id: 'mia' }, { id: 42, login: 'mia', name: null },
        { access: 'ghu_reconnected', refresh: 'ghr_reconnected', accessExpiresAt: ctx.now() + 8 * HOUR, refreshExpiresAt: null }, ctx.now())
      return Response.json({ access_token: 'ghu_stale', refresh_token: 'ghr_stale', expires_in: 8 * 3600 })
    })
    const outcome = await refreshGitHubUserToken({ db: ctx.db, keyring: ctx.keyring, config: gh.config, now: ctx.now }, { account_id: 'user:mia', user_id: 'mia' }, { aheadMs: HOUR })
    expect(outcome).toBe('skipped')
    expect((await memberGitIdentity(ctx.db, ctx.keyring, gh.config, 'user:mia', 'mia', ctx.now()))?.token).toBe('ghu_reconnected')
  })
})

describe('credential push outbox', () => {
  function pushDeps(ctx: Awaited<ReturnType<typeof setup>>, push: PushDeps['push']): PushDeps {
    return { db: ctx.db, now: ctx.now, targets: (change) => credentialPushTargets(ctx.db, change), push }
  }

  it("pushes an account change to the owner's running sandboxes only, then is done", async () => {
    const ctx = await setup()
    await ctx.sandbox('sbx_a', 'mia')
    await ctx.sandbox('sbx_b', 'mia')
    await ctx.sandbox('sbx_c', 'mia', 'stopped')
    await ctx.sandbox('sbx_d', 'ben')
    const pushed: string[] = []
    await pushCredentialChange(pushDeps(ctx, async (id) => (pushed.push(id), true)), { kind: 'account', agent: 'codex', userId: 'mia' })
    expect(pushed.sort()).toEqual(['sbx_a', 'sbx_b'])
    expect(await pending(ctx.db)).toEqual([])
    expect((await pushPendingCredentialChanges(pushDeps(ctx, async () => true))).pending).toBe(0)
  })

  it('pushes a member token change to every workspace they can push from (own and granted)', async () => {
    const ctx = await setup()
    await ctx.sandbox('sbx_own', 'mia', 'running', 'org:acme')
    await ctx.sandbox('sbx_shared', 'ben', 'running', 'org:acme')
    await ctx.sandbox('sbx_other', 'ben', 'running', 'org:acme')
    await ctx.db
      .prepare(`INSERT INTO workspace_grants (id, sandbox_id, account_id, user_id, device_kind, device_label, status, created_at) VALUES ('g1', 'sbx_shared', 'org:acme', 'mia', 'desktop', 'Mac', 'active', 1)`)
      .run()
    expect((await credentialPushTargets(ctx.db, { kind: 'github_user', accountId: 'org:acme', userId: 'mia' })).sort()).toEqual(['sbx_own', 'sbx_shared'])
  })

  it('retries a failed sandbox push with backoff, and re-pushes a change that landed mid-push', async () => {
    const ctx = await setup()
    await ctx.sandbox('sbx_a', 'mia')
    let fail = true
    const deps = pushDeps(ctx, async () => {
      if (fail) {
        throw new Error('vercel 503')
      }
      return true
    })
    await markCredentialChanged(ctx.db, { kind: 'account', agent: 'claude', userId: 'mia' }, ctx.now())
    expect(await pushPendingCredentialChanges(deps)).toMatchObject({ pending: 1, failed: 1 })
    expect((await pushPendingCredentialChanges(deps)).pending).toBe(0)
    ctx.advance(61_000)
    fail = false
    // A newer change arrives while this push runs: the row stays pending for it.
    const midPush = pushDeps(ctx, async () => {
      ctx.advance(10)
      await markCredentialChanged(ctx.db, { kind: 'account', agent: 'claude', userId: 'mia' }, ctx.now())
      return true
    })
    expect(await pushPendingCredentialChanges(midPush)).toMatchObject({ pending: 1, pushed: 1 })
    expect(await pending(ctx.db)).toHaveLength(1)
    expect(await pushPendingCredentialChanges(deps)).toMatchObject({ pending: 1, pushed: 1 })
    expect(await pending(ctx.db)).toEqual([])
  })

  it('pushes an expired sign-in once', async () => {
    const ctx = await setup()
    await putAgentCredential(ctx.db, ctx.keyring, { userId: 'mia', accountId: 'user:mia', agent: 'claude', value: 'sk-ant-oat-x', expiresAt: ctx.now() + HOUR }, ctx.now())
    expect(await markExpiredAccountCredentials(ctx.db, ctx.now())).toBe(0)
    ctx.advance(HOUR)
    expect(await markExpiredAccountCredentials(ctx.db, ctx.now())).toBe(1)
    expect(await pending(ctx.db)).toEqual([{ kind: 'account:claude', subject: 'mia' }])
    ctx.advance(5 * 60_000)
    expect(await markExpiredAccountCredentials(ctx.db, ctx.now())).toBe(0)
  })
})

describe('scheduled Claude revocation checks', () => {
  async function checks(ctx: Awaited<ReturnType<typeof setup>>, verdict: () => Response) {
    const fetch = vi.fn(async () => verdict()) as unknown as typeof globalThis.fetch
    const revoked: string[] = []
    const summary = await runScheduledAccountChecks({ db: ctx.db, keyring: ctx.keyring, provider: claudeAccount, now: ctx.now(), fetch })
    return { summary, revoked, fetch }
  }
  const dead = () => Response.json({ type: 'error', error: { type: 'authentication_error', message: 'invalid' } }, { status: 401 })
  const ok = () => Response.json({ input_tokens: 1 })
  const state = (db: D1Database) =>
    db.prepare(`SELECT state, suspect_at FROM agent_credentials WHERE user_id = 'mia'`).first<{ state: string; suspect_at: number | null }>()

  it('checks sign-ins in use on a schedule; failures only put it in question, never revoke', async () => {
    const ctx = await setup()
    await ctx.sandbox('sbx_a', 'mia')
    await putAgentCredential(ctx.db, ctx.keyring, { userId: 'mia', accountId: 'user:mia', agent: 'claude', value: 'sk-ant-oat-x' }, ctx.now())
    expect((await checks(ctx, ok)).summary).toMatchObject({ due: 1, kept: 1 })
    // Not again for SCHEDULED_CHECK_EVERY_MS.
    ctx.advance(SCHEDULED_CHECK_EVERY_MS - 1)
    expect((await checks(ctx, ok)).summary.due).toBe(0)
    ctx.advance(1)
    expect((await checks(ctx, dead)).summary).toMatchObject({ due: 1, suspect: 1 })
    expect((await state(ctx.db))?.state).toBe('active')
    ctx.advance(SUSPECT_RECHECK_MS - 1)
    expect((await checks(ctx, dead)).summary.due).toBe(0)
    ctx.advance(1)
    // Rechecked while in question; still failing stays "needs check" (no automatic revoke).
    for (let i = 0; i < 3; i++) {
      const again = await checks(ctx, dead)
      expect(again.summary).toMatchObject({ due: 1, suspect: 1, revoked: 0 })
      expect(again.revoked).toEqual([])
      ctx.advance(SUSPECT_RECHECK_MS)
    }
    expect(await state(ctx.db)).toMatchObject({ state: 'active' })
    expect((await state(ctx.db))?.suspect_at).not.toBeNull()
  })

  it('a pass clears a sign-in in question, and a renewal in between is never revoked', async () => {
    const ctx = await setup()
    await ctx.sandbox('sbx_a', 'mia')
    await putAgentCredential(ctx.db, ctx.keyring, { userId: 'mia', accountId: 'user:mia', agent: 'claude', value: 'sk-ant-oat-x' }, ctx.now())
    await checks(ctx, dead)
    ctx.advance(SUSPECT_RECHECK_MS)
    expect((await checks(ctx, ok)).summary).toMatchObject({ kept: 1 })
    expect((await state(ctx.db))?.suspect_at).toBeNull()
    ctx.advance(SCHEDULED_CHECK_EVERY_MS)
    await checks(ctx, dead)
    // Renewed (suspect cleared) while a second failing check is due.
    ctx.advance(SUSPECT_RECHECK_MS)
    await putAgentCredential(ctx.db, ctx.keyring, { userId: 'mia', accountId: 'user:mia', agent: 'claude', value: 'sk-ant-oat-y' }, ctx.now())
    const after = await checks(ctx, dead)
    expect(after.revoked).toEqual([])
    expect((await state(ctx.db))?.state).toBe('active')
  })

  it("doesn't spend checks on sign-ins no running workspace uses", async () => {
    const ctx = await setup()
    await ctx.sandbox('sbx_a', 'mia', 'stopped')
    await putAgentCredential(ctx.db, ctx.keyring, { userId: 'mia', accountId: 'user:mia', agent: 'claude', value: 'sk-ant-oat-x' }, ctx.now())
    const run = await checks(ctx, ok)
    expect(run.summary.due).toBe(0)
    expect(run.fetch).not.toHaveBeenCalled()
  })
})
