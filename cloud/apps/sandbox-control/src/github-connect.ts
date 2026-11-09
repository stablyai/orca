// Binds GitHub App installations to Orca accounts. The desktop asks for a connect URL (signed,
// single-use state carrying its Orca account); GitHub sends the browser back to the setup/callback
// URL; we exchange the OAuth code for a user-to-server token and bind an installation only when that
// GitHub user owns the installation's account (personal) or is an active admin of the org.
// Installation ids in a callback URL are never trusted on their own.
import { z } from 'zod'
import type { GitHubInstallation } from './github-app'

const STATE_TTL_MS = 10 * 60_000

export type GitHubConnectConfig = {
  appSlug: string
  clientId: string
  clientSecret: string
  stateSecret: string
  fetch?: typeof fetch
}

export type InstallationBinding = {
  installation_id: number
  account_id: string
  github_account_id: number
  github_account_login: string
  github_account_type: string
  bound_by_user_id: string
  bound_by_github_user_id: number | null
  method: 'oauth' | 'operator'
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
  k: z.literal('user').optional()
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
  now: number
): Promise<string> {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
  await db
    .prepare('INSERT INTO github_connect_states (nonce, account_id, expires_at) VALUES (?, ?, ?)')
    .bind(nonce, caller.accountId, now + STATE_TTL_MS)
    .run()
  return signState(secret, { n: nonce, a: caller.accountId, u: caller.userId, e: now + STATE_TTL_MS })
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

const UserBody = z.looseObject({ id: z.number().int(), login: z.string() })
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
 * Exchanges the OAuth code and returns the installations this GitHub user may bind: ones on their
 * own account, or on an org where they are an active admin. `only` narrows to one installation id.
 */
export async function verifiedInstallations(
  config: GitHubConnectConfig,
  code: string,
  only?: number
): Promise<{ githubUser: { id: number; login: string }; allowed: VerifiedInstallation[]; denied: number[] }> {
  const doFetch = config.fetch ?? fetch
  const exchanged = await doFetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'orca-sandbox-control' },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code }),
    redirect: 'manual'
  })
  const token = z.looseObject({ access_token: z.string().min(1) }).safeParse(await exchanged.json().catch(() => null))
  if (!exchanged.ok || !token.success) {
    throw new GitHubConnectError('oauth_exchange_failed')
  }
  const userApi = async (path: string) =>
    doFetch(`https://api.github.com${path}`, {
      headers: {
        authorization: `Bearer ${token.data.access_token}`,
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
  return { githubUser: user.data, allowed, denied }
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

export function installUrl(config: GitHubConnectConfig, state: string): string {
  return `https://github.com/apps/${encodeURIComponent(config.appSlug)}/installations/new?state=${encodeURIComponent(state)}`
}

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
  | { bound: string[]; denied: number }
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
  const code = url.searchParams.get('code') ?? ''
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(code)) {
    // Carry the (still untrusted) installation id through OAuth; verification happens on return.
    const carried = await signState(config.stateSecret, { ...state, ...(installationId ? { i: installationId } : {}) })
    return { redirect: authorizeUrl(config, url.origin, carried) }
  }
  if (!(await consumeState(db, state, now))) {
    return { error: 'state_used' }
  }
  if (state.k === 'user') {
    // A member connecting their own GitHub identity: the caller stores the user token.
    return { userConnect: { a: state.a, u: state.u }, code }
  }
  const result = await verifiedInstallations(config, code, installationId)
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
  return { bound: result.allowed.map((i) => i.account.login), denied: result.denied.length }
}
