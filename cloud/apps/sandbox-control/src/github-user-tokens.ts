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
import { GitHubConnectError, authorizeUrl, signState, type GitHubConnectConfig } from './github-connect'
import type { Keyring, SealedSecret } from './secrets-crypto'

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
}

export type TokenSet = { access: string; refresh: string | null; accessExpiresAt: number | null; refreshExpiresAt: number | null }

const binding = (row: { account_id: string; user_id: string }) => ({
  scope: 'github_user',
  ownerId: `${row.account_id}#${row.user_id}`,
  name: 'oauth'
})

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

const TokenResponse = z.looseObject({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive().optional(),
  refresh_token_expires_in: z.number().int().positive().optional()
})
const UserBody = z.looseObject({ id: z.number().int(), login: z.string(), name: z.string().nullable().optional() })

async function tokenRequest(config: GitHubConnectConfig, body: Record<string, string>, now: number): Promise<TokenSet> {
  const doFetch = config.fetch ?? fetch
  const response = await doFetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'orca-sandbox-control' },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, ...body }),
    redirect: 'manual'
  })
  const parsed = TokenResponse.safeParse(await response.json().catch(() => null))
  if (!response.ok || !parsed.success) {
    throw new GitHubConnectError('oauth_exchange_failed')
  }
  return {
    access: parsed.data.access_token,
    refresh: parsed.data.refresh_token ?? null,
    accessExpiresAt: parsed.data.expires_in ? now + parsed.data.expires_in * 1000 : null,
    refreshExpiresAt: parsed.data.refresh_token_expires_in ? now + parsed.data.refresh_token_expires_in * 1000 : null
  }
}

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

export async function disconnectUser(db: D1Database, caller: SandboxCaller): Promise<void> {
  await db.prepare('DELETE FROM github_user_tokens WHERE account_id = ? AND user_id = ?').bind(caller.accountId, caller.userId).run()
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

/** The member's live token (refreshed when near expiry); null when not connected or refresh failed. */
export async function memberGitIdentity(
  db: D1Database,
  keyring: Keyring,
  config: GitHubConnectConfig | null,
  accountId: string,
  userId: string,
  now: number
): Promise<MemberGitIdentity | null> {
  const row = await getUserTokenRow(db, accountId, userId)
  if (!row) {
    return null
  }
  let tokens: TokenSet
  try {
    tokens = JSON.parse(await keyring.open(binding(row), { kekId: row.kek_id, wrappedDek: row.wrapped_dek, ciphertext: row.ciphertext } satisfies SealedSecret)) as TokenSet
  } catch {
    return null
  }
  if (tokens.accessExpiresAt !== null && tokens.accessExpiresAt - now < REFRESH_BEFORE_MS) {
    if (!config || !tokens.refresh || (tokens.refreshExpiresAt !== null && tokens.refreshExpiresAt <= now)) {
      return null
    }
    try {
      tokens = await tokenRequest(config, { grant_type: 'refresh_token', refresh_token: tokens.refresh }, now)
      await storeUserToken(db, keyring, row, { id: row.github_user_id, login: row.github_login, name: row.github_name }, tokens, now)
    } catch {
      return null
    }
  }
  return {
    userId,
    login: row.github_login,
    email: `${row.github_user_id}+${row.github_login}@users.noreply.github.com`,
    name: row.github_name ?? row.github_login,
    token: tokens.access,
    expiresAt: tokens.accessExpiresAt
  }
}

/** Placeholder a member's git sends; stable per (sandbox, member), unguessable across sandboxes. */
export async function memberPlaceholder(sandboxId: string, userId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${sandboxId}:${userId}`)))
  return `orca-ph-${sandboxId}-m${Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')}`
}
