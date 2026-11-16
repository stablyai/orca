// Per-member GitHub identity for git pushes from shared workspaces. A member connects GitHub once
// (the GitHub App's user-to-server OAuth); the token is envelope-encrypted here and never enters a
// VM. Each member with access to a workspace gets their own git placeholder; the egress policy swaps
// it for that member's token, so `git push` from their session lands on GitHub as them, with their
// author identity (GitHub noreply address). Members who never connected fall back to the app.
//   POST   /v1/github/user/connect -> {authorizeUrl}
//   GET    /v1/github/user         -> {connected, login?, githubUserId?}
//   DELETE /v1/github/user
import { z } from 'zod'
import type { SandboxCaller } from './auth'
import { markCredentialChanged } from './credential-outbox'
import { GitHubConnectError, authorizeUrl, signState, tokenRequest, type GitHubConnectConfig, type TokenSet } from './github-connect'
import type { Keyring, SealedSecret, SecretBinding } from './secrets-crypto'

const STATE_TTL_MS = 10 * 60_000
/** Refresh a little before GitHub's 8 h expiry so a push never races it. */
const REFRESH_BEFORE_MS = 30 * 60_000

export type GitHubUserTokenRow = {
  account_id: string
  user_id: string
  github_user_id: number
  github_login: string
  github_name: string | null
  kek_id: string
  wrapped_dek: string
  ciphertext: string
  access_expires_at: number | null
  refresh_expires_at: number | null
  updated_at: number
  refresh_failures?: number
  last_error?: string | null
}

export type { TokenSet }

const binding = (row: { account_id: string; user_id: string }): SecretBinding => ({
  scope: 'github_user',
  ownerId: `${row.account_id}#${row.user_id}`,
  name: 'oauth'
})
/** The AAD identity of a github_user_tokens row (the KEK re-wrap sweep opens rows by it). */
export const githubUserTokenBinding = binding

export async function createUserConnectState(
  db: D1Database,
  secret: string,
  caller: SandboxCaller,
  now: number
): Promise<string> {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
  await db
    .prepare('INSERT INTO github_connect_states (nonce, account_id, expires_at) VALUES (?, ?, ?)')
    .bind(nonce, caller.accountId, now + STATE_TTL_MS)
    .run()
  // `k: user` routes the callback here instead of installation binding.
  return signState(secret, { n: nonce, a: caller.accountId, u: caller.userId, e: now + STATE_TTL_MS, k: 'user' })
}

export function userAuthorizeUrl(config: GitHubConnectConfig, origin: string, state: string): string {
  return authorizeUrl(config, origin, state)
}

const UserBody = z.looseObject({ id: z.number().int(), login: z.string(), name: z.string().nullable().optional() })

export async function storeUserToken(db: D1Database, keyring: Keyring, row: { account_id: string; user_id: string }, user: z.infer<typeof UserBody>, tokens: TokenSet, now: number) {
  const sealed = await keyring.seal(binding(row), JSON.stringify(tokens))
  await db
    .prepare(
      `INSERT INTO github_user_tokens (account_id, user_id, github_user_id, github_login, github_name, kek_id, wrapped_dek,
         ciphertext, access_expires_at, refresh_expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id, user_id) DO UPDATE SET github_user_id = excluded.github_user_id, github_login = excluded.github_login,
         github_name = excluded.github_name, kek_id = excluded.kek_id, wrapped_dek = excluded.wrapped_dek, ciphertext = excluded.ciphertext,
         access_expires_at = excluded.access_expires_at, refresh_expires_at = excluded.refresh_expires_at, updated_at = excluded.updated_at`
    )
    .bind(row.account_id, row.user_id, user.id, user.login, user.name ?? null, sealed.kekId, sealed.wrappedDek, sealed.ciphertext,
      tokens.accessExpiresAt, tokens.refreshExpiresAt, now)
    .run()
  // A new connection starts clean (no backoff, no dead refresh token) and reaches running workspaces.
  await db
    .prepare('UPDATE github_user_tokens SET refresh_failures = 0, next_attempt_at = NULL, last_error = NULL WHERE account_id = ? AND user_id = ?')
    .bind(row.account_id, row.user_id)
    .run()
  await markCredentialChanged(db, { kind: 'github_user', accountId: row.account_id, userId: row.user_id }, now)
}

/** OAuth callback for a `k: user` state: exchange, look up the GitHub user, store encrypted. */
export async function completeUserConnect(
  db: D1Database,
  keyring: Keyring,
  config: GitHubConnectConfig,
  state: { a: string; u: string },
  code: string,
  now: number
): Promise<{ login: string }> {
  const tokens = await tokenRequest(config, { code }, now)
  const doFetch = config.fetch ?? fetch
  const response = await doFetch('https://api.github.com/user', {
    headers: {
      authorization: `Bearer ${tokens.access}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'orca-sandbox-control'
    },
    redirect: 'manual'
  })
  const user = UserBody.safeParse(await response.json().catch(() => null))
  if (!response.ok || !user.success) {
    throw new GitHubConnectError('github_user_unavailable')
  }
  await storeUserToken(db, keyring, { account_id: state.a, user_id: state.u }, user.data, tokens, now)
  console.log(JSON.stringify({ event: 'github_user_connected' }))
  return { login: user.data.login }
}

export function getUserTokenRow(db: D1Database, accountId: string, userId: string): Promise<GitHubUserTokenRow | null> {
  return db
    .prepare('SELECT * FROM github_user_tokens WHERE account_id = ? AND user_id = ?')
    .bind(accountId, userId)
    .first<GitHubUserTokenRow>()
}

export async function disconnectUser(db: D1Database, caller: SandboxCaller, now: number = Date.now()): Promise<void> {
  await db.prepare('DELETE FROM github_user_tokens WHERE account_id = ? AND user_id = ?').bind(caller.accountId, caller.userId).run()
  // Running workspaces drop the identity from their policies (git falls back to the app's token).
  await markCredentialChanged(db, { kind: 'github_user', accountId: caller.accountId, userId: caller.userId }, now)
}

export type MemberGitIdentity = {
  userId: string
  login: string
  /** GitHub's private commit address for this user (id+login@users.noreply.github.com). */
  email: string
  name: string
  token: string
  expiresAt: number | null
}

function openTokens(keyring: Keyring, row: GitHubUserTokenRow): Promise<TokenSet | null> {
  return keyring
    .open(binding(row), { kekId: row.kek_id, wrappedDek: row.wrapped_dek, ciphertext: row.ciphertext } satisfies SealedSecret)
    .then((text) => JSON.parse(text) as TokenSet)
    .catch(() => null)
}

function identityOf(row: GitHubUserTokenRow, userId: string, tokens: TokenSet): MemberGitIdentity {
  return {
    userId,
    login: row.github_login,
    email: `${row.github_user_id}+${row.github_login}@users.noreply.github.com`,
    name: row.github_name ?? row.github_login,
    token: tokens.access,
    expiresAt: tokens.accessExpiresAt
  }
}

/**
 * Pure read for policy compiles: the member's current token, or null when not connected or
 * expired. Never refreshes (credential-refresh.ts keeps it fresh ahead of expiry and pushes the change).
 */
export async function readMemberGitIdentity(db: D1Database, keyring: Keyring, accountId: string, userId: string, now: number): Promise<MemberGitIdentity | null> {
  const row = await getUserTokenRow(db, accountId, userId)
  const tokens = row ? await openTokens(keyring, row) : null
  if (!row || !tokens || (tokens.accessExpiresAt !== null && tokens.accessExpiresAt <= now)) {
    return null
  }
  return identityOf(row, userId, tokens)
}

/** The member's live token (refreshed when near expiry); null when not connected or refresh failed. */
export async function memberGitIdentity(
  db: D1Database,
  keyring: Keyring,
  config: GitHubConnectConfig | null,
  accountId: string,
  userId: string,
  now: number
): Promise<MemberGitIdentity | null> {
  let row = await getUserTokenRow(db, accountId, userId)
  if (!row) {
    return null
  }
  let tokens = await openTokens(keyring, row)
  if (!tokens) {
    return null
  }
  if (tokens.accessExpiresAt !== null && tokens.accessExpiresAt - now < REFRESH_BEFORE_MS) {
    // The central refresher (credential-refresh.ts) normally got here first; this is the lazy fallback, under
    // the same lease, so two isolates never spend one single-use refresh token twice.
    if (config) {
      await refreshGitHubUserToken({ db, keyring, config, now: () => now }, { account_id: accountId, user_id: userId }, { aheadMs: REFRESH_BEFORE_MS })
    }
    row = await getUserTokenRow(db, accountId, userId)
    tokens = row ? await openTokens(keyring, row) : null
    // Someone else's refresh may still be in flight: the current token serves while it is still valid.
    if (!row || !tokens || (tokens.accessExpiresAt !== null && tokens.accessExpiresAt <= now)) {
      return null
    }
  }
  return identityOf(row, userId, tokens)
}

// ---- leased refresh --------------------------------------------------------------------

/** Longer than GitHub's token call plus the write: the holder always finishes inside its lease. */
const USER_TOKEN_LEASE_MS = 60_000
/** GitHub's answers that end a connection: the member must connect GitHub again. */
const DEAD_USER_TOKEN = ['bad_refresh_token', 'refresh_expired', 'no_refresh_token'] as const
const DEAD_USER_TOKEN_SQL = DEAD_USER_TOKEN.map((code) => `'${code}'`).join(', ')

export type UserTokenRefreshDeps = { db: D1Database; keyring: Keyring; config: GitHubConnectConfig; now: () => number }
export type UserTokenRefreshOutcome = 'refreshed' | 'skipped' | 'failed' | 'dead'

/**
 * Refreshes one member's GitHub token if it expires within `aheadMs`, under a per-member lease. The new
 * tokens are written only over the exact row that was refreshed (compare-and-swap on updated_at), so a
 * disconnect or a new connection meanwhile is never overwritten. Ids and error codes only reach the log.
 */
export async function refreshGitHubUserToken(
  deps: UserTokenRefreshDeps,
  key: { account_id: string; user_id: string },
  options: { aheadMs: number }
): Promise<UserTokenRefreshOutcome> {
  const { db } = deps
  const owner = crypto.randomUUID()
  const start = deps.now()
  const acquired = await db
    .prepare(
      `UPDATE github_user_tokens SET lease_owner = ?, lease_until = ?
       WHERE account_id = ? AND user_id = ? AND (lease_until IS NULL OR lease_until <= ?)`
    )
    .bind(owner, start + USER_TOKEN_LEASE_MS, key.account_id, key.user_id, start)
    .run()
  if (acquired.meta.changes !== 1) {
    return 'skipped'
  }
  const release = async (fields: { refresh_failures?: number; next_attempt_at?: number | null; last_error?: string | null }) => {
    const keys = Object.keys(fields) as (keyof typeof fields)[]
    await db
      .prepare(
        `UPDATE github_user_tokens SET lease_owner = NULL, lease_until = NULL${keys.map((k) => `, ${k} = ?`).join('')}
         WHERE account_id = ? AND user_id = ? AND lease_owner = ?`
      )
      .bind(...keys.map((k) => fields[k] ?? null), key.account_id, key.user_id, owner)
      .run()
  }
  try {
    // Read inside the lease: the refresh token spent is always the newest one written.
    const row = await getUserTokenRow(db, key.account_id, key.user_id)
    const tokens = row ? await openTokens(deps.keyring, row) : null
    if (!row || !tokens || tokens.accessExpiresAt === null || tokens.accessExpiresAt - start > options.aheadMs) {
      await release({})
      return 'skipped'
    }
    if (row.last_error && (DEAD_USER_TOKEN as readonly string[]).includes(row.last_error)) {
      await release({})
      return 'dead'
    }
    const failures = (row.refresh_failures ?? 0) + 1
    if (!tokens.refresh || (tokens.refreshExpiresAt !== null && tokens.refreshExpiresAt <= start)) {
      const code = tokens.refresh ? 'refresh_expired' : 'no_refresh_token'
      await release({ refresh_failures: failures, last_error: code, next_attempt_at: null })
      userTokenLog('github_user_token_dead', { code })
      await markCredentialChanged(db, { kind: 'github_user', accountId: key.account_id, userId: key.user_id }, deps.now())
      return 'dead'
    }
    let next: TokenSet
    try {
      next = await tokenRequest(deps.config, { grant_type: 'refresh_token', refresh_token: tokens.refresh }, start)
    } catch (error) {
      const code = error instanceof GitHubConnectError ? (error.reason ?? error.code) : 'network'
      if (code === 'bad_refresh_token') {
        await release({ refresh_failures: failures, last_error: code, next_attempt_at: null })
        userTokenLog('github_user_token_dead', { code })
        await markCredentialChanged(db, { kind: 'github_user', accountId: key.account_id, userId: key.user_id }, deps.now())
        return 'dead'
      }
      // Transient: back off 1, 2, 4 ... 30 min; the current token keeps serving until it expires.
      await release({ refresh_failures: failures, last_error: code, next_attempt_at: deps.now() + Math.min(30, 2 ** (failures - 1)) * 60_000 })
      userTokenLog('github_user_token_refresh_failed', { code, failures })
      return 'failed'
    }
    const now = deps.now()
    const sealed = await deps.keyring.seal(binding(row), JSON.stringify(next))
    const swapped = await db
      .prepare(
        `UPDATE github_user_tokens SET kek_id = ?, wrapped_dek = ?, ciphertext = ?, access_expires_at = ?, refresh_expires_at = ?, updated_at = ?
         WHERE account_id = ? AND user_id = ? AND updated_at = ? AND lease_owner = ?`
      )
      .bind(sealed.kekId, sealed.wrappedDek, sealed.ciphertext, next.accessExpiresAt, next.refreshExpiresAt, Math.max(now, row.updated_at + 1),
        key.account_id, key.user_id, row.updated_at, owner)
      .run()
    await release(swapped.meta.changes === 1 ? { refresh_failures: 0, next_attempt_at: null, last_error: null } : {})
    if (swapped.meta.changes !== 1) {
      // Disconnected or reconnected meanwhile: the refreshed tokens belong to nobody now.
      return 'skipped'
    }
    userTokenLog('github_user_token_refreshed', {})
    // Every running workspace holding the old token in its policy gets the new one (credential-outbox.ts).
    await markCredentialChanged(db, { kind: 'github_user', accountId: key.account_id, userId: key.user_id }, now)
    return 'refreshed'
  } catch (error) {
    await release({ last_error: 'internal' }).catch(() => undefined)
    userTokenLog('github_user_token_refresh_error', { error: String(error).slice(0, 120) })
    return 'failed'
  }
}

/**
 * Members whose GitHub token expires within `aheadMs` and who can push from a running workspace right now
 * (its owner, or an active grant on it): the only tokens a live policy can be holding. Everyone else's token
 * is refreshed lazily at their next boot or request (memberGitIdentity).
 */
export async function dueGitHubUserTokens(db: D1Database, now: number, aheadMs: number, limit: number): Promise<{ account_id: string; user_id: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT t.account_id, t.user_id FROM github_user_tokens t
       WHERE t.access_expires_at IS NOT NULL AND t.access_expires_at <= ?
         AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= ?)
         AND (t.last_error IS NULL OR t.last_error NOT IN (${DEAD_USER_TOKEN_SQL}))
         AND (t.lease_until IS NULL OR t.lease_until <= ?)
         AND EXISTS (SELECT 1 FROM sandboxes s WHERE s.account_id = t.account_id AND s.status = 'running' AND s.repo_url IS NOT NULL
           AND ((s.user_id = t.user_id AND s.ownership_transferred_at IS NULL)
             OR EXISTS (SELECT 1 FROM workspace_grants g WHERE g.sandbox_id = s.id AND g.user_id = t.user_id AND g.status = 'active')))
       ORDER BY t.access_expires_at LIMIT ?`
    )
    .bind(now + aheadMs, now, now, limit)
    .all<{ account_id: string; user_id: string }>()
  return results
}

function userTokenLog(event: string, fields: Record<string, unknown>) {
  // Codes and counts only; never a token, a login or an id that names the member.
  console.log(JSON.stringify({ event, ...fields }))
}

/** Placeholder a member's git sends; stable per (sandbox, member), unguessable across sandboxes. */
export async function memberPlaceholder(sandboxId: string, userId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${sandboxId}:${userId}`)))
  return `orca-ph-${sandboxId}-m${Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')}`
}
