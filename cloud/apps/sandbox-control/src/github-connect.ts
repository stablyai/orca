// Binds GitHub App installations to Orca accounts. The desktop asks for a connect URL (signed,
// single-use state carrying its Orca account); GitHub sends the browser back to the setup/callback
// URL; we exchange the OAuth code for a user-to-server token and bind an installation only when that
// GitHub user owns the installation's account (personal) or is an active admin of the org.
// Installation ids in a callback URL are never trusted on their own.
import { z } from 'zod'
import type { GitHubInstallation } from './github-app'

const STATE_TTL_MS = 10 * 60_000
/** Billing's cloud setup session ids (cloud-setup.ts): `cs_` + 22 base64url characters. */
export const SETUP_SESSION_ID = /^cs_[A-Za-z0-9_-]{22}$/
/** How long a pending org-install request waits for an owner's approval. */
export const INSTALL_REQUEST_TTL_MS = 30 * 24 * 60 * 60_000

export type GitHubConnectConfig = {
  appSlug: string
  clientId: string
  clientSecret: string
  stateSecret: string
  fetch?: typeof fetch
  // N5: checks a just-installed installation against the GitHub identity carried in the state,
  // with the App's own credentials. Null (or absent): fall back to GitHub's Authorize page.
  verifyInstaller?: (installationId: number, user: { id: number; login: string }) => Promise<GitHubInstallation | null>
}

/**
 * The installation if `user` may bind it: it is on their own account, or they are an active admin
 * of its org. Reads GitHub with the App's credentials only (no user token needed).
 */
export async function installerFromIdentity(
  minter: { getInstallation(id: number): Promise<GitHubInstallation | null>; orgMembership?: (id: number, org: string, login: string) => Promise<{ state: string; role: string; userId: number } | null> },
  installationId: number,
  user: { id: number; login: string }
): Promise<GitHubInstallation | null> {
  const installation = await minter.getInstallation(installationId)
  if (!installation) {
    return null
  }
  if (installation.account.type === 'User') {
    return installation.account.id === user.id ? installation : null
  }
  const membership = await minter.orgMembership?.(installationId, installation.account.login, user.login)
  return membership && membership.state === 'active' && membership.role === 'admin' && membership.userId === user.id
    ? installation
    : null
}

export type InstallationBinding = {
  installation_id: number
  account_id: string
  github_account_id: number
  github_account_login: string
  github_account_type: string
  bound_by_user_id: string
  bound_by_github_user_id: number | null
  /** `request`: an org owner approved an install requested (OAuth-proven) by this GitHub user. */
  method: 'oauth' | 'operator' | 'request' | 'idp'
  created_at: number
  revoked_at: number | null
}

// ---- D1 ----

export async function isInstallationBound(db: D1Database, installationId: number, accountId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS ok FROM github_installations WHERE installation_id = ? AND account_id = ? AND revoked_at IS NULL')
    .bind(installationId, accountId)
    .first<{ ok: number }>()
  return row !== null
}

export async function bindInstallation(
  db: D1Database,
  binding: Omit<InstallationBinding, 'created_at' | 'revoked_at'>,
  now: number
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO github_installations (installation_id, account_id, github_account_id, github_account_login,
         github_account_type, bound_by_user_id, bound_by_github_user_id, method, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT (installation_id, account_id) DO UPDATE SET github_account_id = excluded.github_account_id,
         github_account_login = excluded.github_account_login, github_account_type = excluded.github_account_type,
         bound_by_user_id = excluded.bound_by_user_id, bound_by_github_user_id = excluded.bound_by_github_user_id,
         method = excluded.method, created_at = excluded.created_at, revoked_at = NULL`
    )
    .bind(binding.installation_id, binding.account_id, binding.github_account_id, binding.github_account_login,
      binding.github_account_type, binding.bound_by_user_id, binding.bound_by_github_user_id, binding.method, now)
    .run()
}

export async function revokeInstallation(db: D1Database, installationId: number, accountId: string | null, now: number) {
  const result = await db
    .prepare(
      `UPDATE github_installations SET revoked_at = ? WHERE installation_id = ? AND revoked_at IS NULL
       ${accountId ? 'AND account_id = ?' : ''}`
    )
    .bind(...(accountId ? [now, installationId, accountId] : [now, installationId]))
    .run()
  return result.meta.changes
}

export async function listAccountInstallations(db: D1Database, accountId: string) {
  const { results } = await db
    .prepare(
      `SELECT installation_id, github_account_login, github_account_type, method, created_at
       FROM github_installations WHERE account_id = ? AND revoked_at IS NULL ORDER BY created_at`
    )
    .bind(accountId)
    .all<{ installation_id: number; github_account_login: string; github_account_type: string; method: string; created_at: number }>()
  return results
}

// ---- signed state ----

const StatePayload = z.object({
  n: z.string().regex(/^[a-f0-9]{32}$/),
  a: z.string().min(1).max(160),
  u: z.string().min(1).max(160),
  e: z.number().int(),
  i: z.number().int().positive().optional(),
  // `user`: a member connecting their own GitHub identity (github-user-tokens.ts), not an install.
  k: z.literal('user').optional(),
  // Cloud setup session waiting on this install (billing's cloud-setup.ts); the browser goes back to it.
  s: z.string().regex(SETUP_SESSION_ID).optional(),
  // owner/repo the install was started for (repo-access, install-request recording).
  r: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/).max(200).optional(),
  // GitHub sent the browser back with setup_action=request: a non-owner asked an org owner to install.
  q: z.literal(1).optional(),
  // N5: the GitHub identity Orca Cloud auth verified from the user's GitHub sign-in (billing's setup
  // chain passes it). Lets the install bind without GitHub's separate Authorize page.
  g: z.object({ id: z.number().int().positive(), l: z.string().regex(/^[A-Za-z0-9-]{1,39}$/) }).optional()
})
export type ConnectState = z.infer<typeof StatePayload>

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
const fromB64url = (text: string) => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0))

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)))
}

export async function signState(secret: string, payload: ConnectState): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)))
  return `${body}.${b64url(await hmac(secret, body))}`
}

/** Null on a bad signature, malformed payload or expiry. Does not consume the nonce. */
export async function verifyState(secret: string, state: string, now: number): Promise<ConnectState | null> {
  const [body, mac, extra] = state.split('.')
  if (!body || !mac || extra !== undefined || state.length > 2048) {
    return null
  }
  try {
    const expected = await hmac(secret, body)
    const given = fromB64url(mac)
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return null
    }
    const parsed = StatePayload.safeParse(JSON.parse(new TextDecoder().decode(fromB64url(body))))
    return parsed.success && parsed.data.e > now ? parsed.data : null
  } catch {
    return null
  }
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  }
  return diff === 0
}

export async function createConnectState(
  db: D1Database,
  secret: string,
  caller: { accountId: string; userId: string },
  now: number,
  context: {
    setupSessionId?: string
    repo?: { owner: string; repo: string }
    githubUser?: { id: number; login: string }
  } = {}
): Promise<string> {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
  await db
    .prepare('INSERT INTO github_connect_states (nonce, account_id, expires_at) VALUES (?, ?, ?)')
    .bind(nonce, caller.accountId, now + STATE_TTL_MS)
    .run()
  return signState(secret, {
    n: nonce,
    a: caller.accountId,
    u: caller.userId,
    e: now + STATE_TTL_MS,
    ...(context.setupSessionId && SETUP_SESSION_ID.test(context.setupSessionId) ? { s: context.setupSessionId } : {}),
    ...(context.repo ? { r: `${context.repo.owner}/${context.repo.repo}` } : {}),
    ...(context.githubUser ? { g: { id: context.githubUser.id, l: context.githubUser.login } } : {})
  })
}

/** Marks the nonce used; false when it was already used, unknown, or issued to another account. */
async function consumeState(db: D1Database, state: ConnectState, now: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE github_connect_states SET consumed_at = ? WHERE nonce = ? AND account_id = ? AND consumed_at IS NULL AND expires_at > ?`
    )
    .bind(now, state.n, state.a, now)
    .run()
  return result.meta.changes === 1
}

// ---- GitHub user-to-server verification ----

const UserBody = z.looseObject({ id: z.number().int(), login: z.string(), name: z.string().nullable().optional() })
export type GitHubUser = z.infer<typeof UserBody>

/** A GitHub App user-to-server token set. Expiring user tokens carry a refresh token and both expiries. */
export type TokenSet = { access: string; refresh: string | null; accessExpiresAt: number | null; refreshExpiresAt: number | null }

const TokenResponse = z.looseObject({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive().optional(),
  refresh_token_expires_in: z.number().int().positive().optional()
})

/** POSTs to GitHub's OAuth token endpoint: a `code` exchange (single-use) or a refresh. */
export async function tokenRequest(config: GitHubConnectConfig, body: Record<string, string>, now: number): Promise<TokenSet> {
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
const UserInstallations = z.looseObject({
  installations: z.array(
    z.looseObject({
      id: z.number().int(),
      account: z.looseObject({ id: z.number().int(), login: z.string(), type: z.enum(['User', 'Organization']) })
    })
  )
})
const Membership = z.looseObject({ state: z.string(), role: z.string() })

export type VerifiedInstallation = GitHubInstallation & { githubUserId: number }

/**
 * Exchanges the OAuth code (once: GitHub codes are single-use) and returns the installations this
 * GitHub user may bind: ones on their own account, or on an org where they are an active admin.
 * `only` narrows to one installation id. The user's token set comes back too, so the caller can keep
 * it as that member's commit identity.
 */
export async function verifiedInstallations(
  config: GitHubConnectConfig,
  code: string,
  now: number,
  only?: number
): Promise<{ githubUser: GitHubUser; tokens: TokenSet; allowed: VerifiedInstallation[]; denied: number[] }> {
  const doFetch = config.fetch ?? fetch
  const tokens = await tokenRequest(config, { code }, now)
  const userApi = async (path: string) =>
    doFetch(`https://api.github.com${path}`, {
      headers: {
        authorization: `Bearer ${tokens.access}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'orca-sandbox-control'
      },
      redirect: 'manual'
    })
  const userResponse = await userApi('/user')
  const user = UserBody.safeParse(await userResponse.json().catch(() => null))
  if (!userResponse.ok || !user.success) {
    throw new GitHubConnectError('github_user_unavailable')
  }
  const listed = await userApi('/user/installations?per_page=100')
  const installations = UserInstallations.safeParse(await listed.json().catch(() => null))
  if (!listed.ok || !installations.success) {
    throw new GitHubConnectError('github_installations_unavailable')
  }
  const candidates = installations.data.installations.filter((i) => only === undefined || i.id === only)
  const allowed: VerifiedInstallation[] = []
  const denied: number[] = []
  for (const installation of candidates) {
    let ok = false
    if (installation.account.type === 'User') {
      ok = installation.account.id === user.data.id
    } else {
      // Org: only an active org admin may bind it (needs the app's Members:read org permission).
      const membership = await userApi(`/user/memberships/orgs/${encodeURIComponent(installation.account.login)}`)
      const body = Membership.safeParse(await membership.json().catch(() => null))
      ok = membership.ok && body.success && body.data.state === 'active' && body.data.role === 'admin'
    }
    if (ok) {
      allowed.push({ id: installation.id, account: installation.account, githubUserId: user.data.id })
    } else {
      denied.push(installation.id)
    }
  }
  if (only !== undefined && candidates.length === 0) {
    denied.push(only)
  }
  return { githubUser: user.data, tokens, allowed, denied }
}

export class GitHubConnectError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'GitHubConnectError'
  }
}

export function authorizeUrl(config: GitHubConnectConfig, origin: string, state: string): string {
  const url = new URL('https://github.com/login/oauth/authorize')
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', `${origin}/v1/github/callback`)
  url.searchParams.set('state', state)
  url.searchParams.set('allow_signup', 'false')
  return url.toString()
}

/**
 * GitHub App install page. With the owner's and the repository's numeric ids it opens on the
 * permissions step with that account chosen and only that repository selected, using the two
 * parameters GitHub documents for this page ("Migrating OAuth apps to GitHub Apps"):
 * `/installations/new/permissions?suggested_target_id=<user or org id>&repository_ids[]=<repo id>`.
 * suggested_target_id is required there and an omitted repository_ids[] means "All repositories",
 * so without both ids we use the plain page and let the user pick (least privilege over one click).
 * `state` is GitHub's documented install-URL parameter ("Sharing your GitHub App"). `target_id` is
 * not a documented install-URL parameter, so it is never sent.
 */
export function installUrl(
  config: GitHubConnectConfig,
  state: string,
  preselect?: { ownerId: number; repoId: number } | null
): string {
  const base = `https://github.com/apps/${encodeURIComponent(config.appSlug)}/installations/new`
  if (preselect && Number.isSafeInteger(preselect.ownerId) && preselect.ownerId > 0 && Number.isSafeInteger(preselect.repoId) && preselect.repoId > 0) {
    return `${base}/permissions?suggested_target_id=${preselect.ownerId}&repository_ids[]=${preselect.repoId}&state=${encodeURIComponent(state)}`
  }
  return `${base}?state=${encodeURIComponent(state)}`
}

// ---- installation requests (an org owner must approve) ----

export type InstallRequestRow = {
  id: string
  account_id: string
  user_id: string
  github_user_id: number
  github_login: string
  owner_login: string
  repo_url: string | null
  setup_session_id: string | null
  created_at: number
  expires_at: number
  resolved_at: number | null
  installation_id: number | null
}

export async function recordInstallRequest(
  db: D1Database,
  request: { accountId: string; userId: string; githubUser: { id: number; login: string }; owner: string; repoUrl: string | null; setupSessionId: string | null },
  now: number
): Promise<void> {
  const owner = request.owner.toLowerCase()
  // One open request per account, requester and owner: a second Request click refreshes it.
  await db
    .prepare(
      `UPDATE github_install_requests SET resolved_at = ? WHERE account_id = ? AND github_user_id = ? AND owner_login = ? AND resolved_at IS NULL`
    )
    .bind(now, request.accountId, request.githubUser.id, owner)
    .run()
  await db
    .prepare(
      `INSERT INTO github_install_requests (id, account_id, user_id, github_user_id, github_login, owner_login, repo_url,
         setup_session_id, created_at, expires_at, resolved_at, installation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
    )
    .bind(
      crypto.randomUUID(),
      request.accountId,
      request.userId,
      request.githubUser.id,
      request.githubUser.login,
      owner,
      request.repoUrl,
      request.setupSessionId,
      now,
      now + INSTALL_REQUEST_TTL_MS
    )
    .run()
}

/** The account's open request for a GitHub owner, if any. */
export async function openInstallRequest(db: D1Database, accountId: string, owner: string, now: number): Promise<InstallRequestRow | null> {
  return db
    .prepare(
      `SELECT * FROM github_install_requests WHERE account_id = ? AND owner_login = ? AND resolved_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .bind(accountId, owner.toLowerCase(), now)
    .first<InstallRequestRow>()
}

/**
 * An org owner approved: GitHub's `installation.created` names the requester. Binds the new
 * installation to every Orca account whose open request came from that same (OAuth-proven) GitHub
 * user for that org, and resolves those requests. Returns the requests it resolved.
 */
export async function bindApprovedRequests(
  db: D1Database,
  installation: { id: number; account: { id: number; login: string; type: string } },
  requesterGithubUserId: number,
  now: number
): Promise<InstallRequestRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM github_install_requests WHERE github_user_id = ? AND owner_login = ? AND resolved_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC LIMIT 20`
    )
    .bind(requesterGithubUserId, installation.account.login.toLowerCase(), now)
    .all<InstallRequestRow>()
  const resolved: InstallRequestRow[] = []
  const seen = new Set<string>()
  for (const request of results) {
    if (!seen.has(request.account_id)) {
      seen.add(request.account_id)
      await bindInstallation(
        db,
        {
          installation_id: installation.id,
          account_id: request.account_id,
          github_account_id: installation.account.id,
          github_account_login: installation.account.login,
          github_account_type: installation.account.type,
          bound_by_user_id: request.user_id,
          bound_by_github_user_id: requesterGithubUserId,
          method: 'request'
        },
        now
      )
    }
    await db
      .prepare('UPDATE github_install_requests SET resolved_at = ?, installation_id = ? WHERE id = ?')
      .bind(now, installation.id, request.id)
      .run()
    resolved.push(request)
  }
  return resolved
}

/** Accounts holding a live binding to an installation. */
export async function boundAccounts(db: D1Database, installationId: number): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT account_id FROM github_installations WHERE installation_id = ? AND revoked_at IS NULL LIMIT 50')
    .bind(installationId)
    .all<{ account_id: string }>()
  return results.map((row) => row.account_id)
}

/** The OAuth-proven GitHub user behind a bind or install request, with their user-to-server token. */
export type OAuthIdentity = { user: GitHubUser; tokens: TokenSet }

/**
 * Setup URL (after install) and OAuth callback. Without a code we send the browser through OAuth so
 * GitHub proves who the installer is; the installation id is carried inside a re-signed state.
 */
export async function handleGitHubReturn(
  db: D1Database,
  config: GitHubConnectConfig,
  url: URL,
  now: number
): Promise<
  | { redirect: string }
  | {
      bound: string[]
      boundIds: { githubOwnerId: number; githubUserId: number }[]
      denied: number
      state: ConnectState
      /** OAuth binds only: the binder's GitHub user and token, to keep as their commit identity. */
      identity?: OAuthIdentity
    }
  | { requested: { owner: string }; state: ConnectState; identity?: OAuthIdentity }
  | { error: string }
  | { userConnect: { a: string; u: string }; code: string }
> {
  const rawState = url.searchParams.get('state') ?? ''
  const state = rawState ? await verifyState(config.stateSecret, rawState, now) : null
  if (!state) {
    return { error: 'invalid_state' }
  }
  const queryInstallation = Number(url.searchParams.get('installation_id') ?? NaN)
  const installationId = state.i ?? (Number.isSafeInteger(queryInstallation) && queryInstallation > 0 ? queryInstallation : undefined)
  // GitHub's Request button (a member who isn't an org owner) returns with setup_action=request.
  const requested = state.q === 1 || (url.searchParams.get('setup_action') === 'request' && !installationId)
  const code = url.searchParams.get('code') ?? ''
  const hasCode = /^[A-Za-z0-9_-]{8,128}$/.test(code)
  if (!hasCode && state.g && installationId && !requested && state.k !== 'user' && config.verifyInstaller) {
    // N5: the user signed in to Orca with GitHub; check that identity against the installation with
    // the App's credentials and skip GitHub's Authorize page. Any doubt falls through to OAuth.
    const installation = await config.verifyInstaller(installationId, { id: state.g.id, login: state.g.l }).catch(() => null)
    if (installation) {
      if (!(await consumeState(db, state, now))) {
        return { error: 'state_used' }
      }
      await bindInstallation(
        db,
        {
          installation_id: installation.id,
          account_id: state.a,
          github_account_id: installation.account.id,
          github_account_login: installation.account.login,
          github_account_type: installation.account.type,
          bound_by_user_id: state.u,
          bound_by_github_user_id: state.g.id,
          method: 'idp'
        },
        now
      )
      console.log(JSON.stringify({ event: 'github_bind', method: 'idp', bound: 1, denied: 0 }))
      return {
        bound: [installation.account.login],
        boundIds: [{ githubOwnerId: installation.account.id, githubUserId: state.g.id }],
        denied: 0,
        state
      }
    }
  }
  if (!hasCode) {
    // Carry the (still untrusted) installation id through OAuth; verification happens on return.
    const carried = await signState(config.stateSecret, {
      ...state,
      ...(installationId ? { i: installationId } : {}),
      ...(requested ? { q: 1 as const } : {})
    })
    return { redirect: authorizeUrl(config, url.origin, carried) }
  }
  if (!(await consumeState(db, state, now))) {
    return { error: 'state_used' }
  }
  if (state.k === 'user') {
    // A member connecting their own GitHub identity: the caller stores the user token.
    return { userConnect: { a: state.a, u: state.u }, code }
  }
  const result = await verifiedInstallations(config, code, now, installationId)
  const identity: OAuthIdentity = { user: result.githubUser, tokens: result.tokens }
  if (requested && !installationId) {
    // Nothing is installed yet: remember who asked (OAuth-proven) so the owner's approval binds it.
    const owner = state.r?.split('/')[0]
    if (!owner) {
      return { error: 'request_without_repo' }
    }
    await recordInstallRequest(
      db,
      {
        accountId: state.a,
        userId: state.u,
        githubUser: result.githubUser,
        owner,
        repoUrl: `https://github.com/${state.r}`,
        setupSessionId: state.s ?? null
      },
      now
    )
    console.log(JSON.stringify({ event: 'github_install_requested' }))
    return { requested: { owner }, state, identity }
  }
  for (const installation of result.allowed) {
    await bindInstallation(
      db,
      {
        installation_id: installation.id,
        account_id: state.a,
        github_account_id: installation.account.id,
        github_account_login: installation.account.login,
        github_account_type: installation.account.type,
        bound_by_user_id: state.u,
        bound_by_github_user_id: installation.githubUserId,
        method: 'oauth'
      },
      now
    )
  }
  console.log(JSON.stringify({ event: 'github_bind', bound: result.allowed.length, denied: result.denied.length }))
  return {
    bound: result.allowed.map((i) => i.account.login),
    // Numeric GitHub ids for billing's trial abuse keys (per GitHub owner and per GitHub user).
    boundIds: result.allowed.map((i) => ({ githubOwnerId: i.account.id, githubUserId: i.githubUserId })),
    denied: result.denied.length,
    state,
    // Zero allowed installations: nothing was proven worth keeping, so no identity either.
    ...(result.allowed.length > 0 ? { identity } : {})
  }
}
