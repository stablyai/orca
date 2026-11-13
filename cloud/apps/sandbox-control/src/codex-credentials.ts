// Codex "via your Orca account" (agent-accounts spec A2, contract D11, flag S2): the ChatGPT login a broker
// sandbox made (codex-broker.ts) lives here, Personal only, and a lease refresher keeps it fresh centrally.
//
// - Storage: agent_credentials (agent 'codex'), value = JSON {access_token, refresh_token, id_token, account_id},
//   envelope-encrypted. Never logged, never returned, never in a sandbox.
// - Workspaces: a placeholder ~/.codex/auth.json (placeholder access token, no refresh token) written by the
//   VM env script from ORCA_CODEX_AUTH_PLACEHOLDER; the egress proxy swaps the real access token on
//   chatgpt.com, where Codex's ChatGPT backend lives (chatgpt.com/backend-api/codex/...).
// - Refresh: a refresh token is single-use. Only the lease holder spends it, and the new tokens are written
//   with a compare-and-swap, so a racing refresh, delete or new login can never resurrect a spent token
//   (that is what `refresh_token_reused` punishes).
import { decodeJwt } from 'jose'
import type { AccountProvider } from './account-providers'
import { credentialBinding, putAgentCredential, readUsableAgentCredential } from './agent-credentials'
import type { Keyring } from './secrets-crypto'
import type { SandboxRow } from './store'

/** Codex CLI's public OAuth client (codex-rs login crate) and token endpoint. */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'
/** Where Codex sends a ChatGPT login's bearer token (responses, usage, plugins: all under /backend-api). */
export const CODEX_ACCOUNT_HOSTS: readonly string[] = ['chatgpt.com']
/** Session env name the VM env script turns into ~/.codex/auth.json (ORCA_* never reaches shells). */
export const CODEX_PLACEHOLDER_ENV = 'ORCA_CODEX_AUTH_PLACEHOLDER'

/** Refresh this long before the access token expires (ChatGPT access tokens last about 10 days). */
export const REFRESH_AHEAD_MS = 3 * 24 * 60 * 60_000
/** And at least this often, whatever the token says (Codex itself refreshes every 8 days). */
export const REFRESH_EVERY_MS = 7 * 24 * 60 * 60_000
/** Longer than the token call's timeout plus the write: the holder always finishes inside its lease. */
export const LEASE_MS = 120_000
const TOKEN_TIMEOUT_MS = 20_000
/** A 401 at egress triggers a refresh only if the last one is older than this. */
const UNAUTHORIZED_REFRESH_MS = 5 * 60_000
const BATCH = 20
/** Placeholder tokens claim a far-future expiry so Codex in the sandbox never tries to refresh. */
const PLACEHOLDER_EXP = 4_102_444_800 // 2100-01-01

export type CodexTokens = { access_token: string; refresh_token: string; id_token: string; account_id: string | null }

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 16_384

/** The tokens of a Codex auth.json (ChatGPT login), or null when it is not one. */
export function parseCodexAuthJson(text: string): CodexTokens | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const tokens = (parsed as { tokens?: Record<string, unknown> } | null)?.tokens
  if (!tokens || !isText(tokens.access_token) || !isText(tokens.refresh_token) || !isText(tokens.id_token)) {
    return null
  }
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    id_token: tokens.id_token,
    account_id: isText(tokens.account_id) ? tokens.account_id : (accountIdFrom(tokens.id_token) ?? null)
  }
}

export function parseStoredCodex(value: string): CodexTokens | null {
  return parseCodexAuthJson(JSON.stringify({ tokens: safeJson(value) }))
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function claims(token: string): Record<string, unknown> | null {
  try {
    return decodeJwt(token) as Record<string, unknown>
  } catch {
    return null
  }
}

function accountIdFrom(idToken: string): string | undefined {
  const auth = claims(idToken)?.['https://api.openai.com/auth'] as Record<string, unknown> | undefined
  return isText(auth?.chatgpt_account_id) ? auth.chatgpt_account_id : undefined
}

/** Access-token expiry (ms), from its JWT `exp`; null when it is not a JWT. */
export function accessExpiry(tokens: Pick<CodexTokens, 'access_token'>): number | null {
  const exp = claims(tokens.access_token)?.exp
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null
}

/** What the person sees for this login: the ChatGPT email (from the id token). Never a plan name (Q4). */
export function codexLabel(tokens: Pick<CodexTokens, 'id_token'>): string | null {
  const c = claims(tokens.id_token)
  const profile = c?.['https://api.openai.com/profile'] as Record<string, unknown> | undefined
  const email = c?.email ?? profile?.email
  return typeof email === 'string' && email.length <= 200 ? email : null
}

const b64url = (value: string) => btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

/**
 * The sandbox's placeholder access token: JWT-shaped (Codex reads `exp` and the auth claims from it) but
 * unsigned and bound to the sandbox id, so a clone or rollover gets its own (D14). Not a secret: the proxy
 * authenticates the sandbox by Vercel's OIDC token; the placeholder only marks the header to swap.
 */
export function codexPlaceholder(row: Pick<SandboxRow, 'id'>): string {
  const header = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ iss: 'orca-placeholder', sub: row.id, exp: PLACEHOLDER_EXP }))
  return `${header}.${payload}.orca-placeholder`
}

/** `Bearer <access token>` from the stored JSON (or a bare token: the placeholder itself). */
function formatCodex(credential: string): string {
  const stored = credential.startsWith('{') ? parseStoredCodex(credential) : null
  return `Bearer ${stored ? stored.access_token : credential}`
}

/**
 * The ChatGPT backend calls Codex makes with its login (seen live, Codex 0.166): the Codex API itself, its
 * plugin catalog and usage. Nothing else on chatgpt.com (conversations, memories, connectors) gets the token.
 */
const CODEX_PREFIXES = ['/backend-api/codex/']
const CODEX_EXACT_GETS = new Set([
  '/backend-api/ps/plugins/list',
  '/backend-api/ps/plugins/installed',
  '/backend-api/ps/plugins/suggested/codex',
  '/backend-api/plugins/featured',
  '/backend-api/plugins/export/curated',
  '/backend-api/wham/usage'
])

export function codexPathAllowed(method: string, path: string): boolean {
  const pathname = path.split('?')[0] ?? ''
  // Plain segments only: no encoded or dot segments that could walk out of an allowed prefix.
  if (!/^(\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+\/?$/.test(pathname) || /(^|\/)\.\.?(\/|$)/.test(pathname)) {
    return false
  }
  if (CODEX_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return true
  }
  return method.toUpperCase() === 'GET' && CODEX_EXACT_GETS.has(pathname)
}

export const codexAccount: AccountProvider = {
  agent: 'codex',
  hosts: CODEX_ACCOUNT_HOSTS,
  placeholder: codexPlaceholder,
  sessionEnv: (row) => ({ [CODEX_PLACEHOLDER_ENV]: codexPlaceholder(row) }),
  header: 'authorization',
  format: formatCodex,
  pathAllowed: codexPathAllowed,
  // Codex sends its ChatGPT workspace id with a real login; the placeholder file can't know it.
  extraHeaders: (credential): Record<string, string> => {
    const account = credential.startsWith('{') ? parseStoredCodex(credential)?.account_id : null
    return account ? { 'chatgpt-account-id': account } : {}
  },
  // A 401 from chatgpt.com: refresh now instead of revoking (the refresher revokes a dead login itself).
  // At most once per UNAUTHORIZED_REFRESH_MS, so a burst of 401s never spends token after token.
  onUnauthorized: async ({ db, keyring, userId, now, waitUntil }) => {
    const lease = await db
      .prepare('SELECT refreshed_at, next_attempt_at, last_error FROM codex_leases WHERE user_id = ?')
      .bind(userId)
      .first<{ refreshed_at: number | null; next_attempt_at: number | null; last_error: string | null }>()
    if (
      (lease?.refreshed_at && now - lease.refreshed_at < UNAUTHORIZED_REFRESH_MS) ||
      (lease?.next_attempt_at && lease.next_attempt_at > now) ||
      (lease?.last_error && DEAD_LOGIN.has(lease.last_error))
    ) {
      return
    }
    log('codex_token_unauthorized', { userId })
    waitUntil(refreshCodexCredential({ db, keyring, now: () => now }, userId))
  },
  // RS-4: a request still carrying this sandbox's placeholder once the account no longer applies gets a
  // message saying what to do, not a bare proxy 403. Still a 403, never a 401: on a 401 from chatgpt.com
  // Codex runs its own token refresh (against auth.openai.com, with a placeholder refresh token) and
  // retries, so a 401 would only cost refresh attempts. On any other status Codex prints
  // `unexpected status <code>: <body>`, so the body is the message, in ChatGPT's own error shape.
  signedOut: {
    status: 403,
    contentType: 'application/json',
    body: JSON.stringify({
      detail: 'Orca Cloud can’t use your ChatGPT sign-in here. Check it in Orca: Settings → Agent accounts.'
    })
  },
  credential: async (db, keyring, userId, now) => {
    const value = await readUsableAgentCredential(db, keyring, userId, 'codex', now)
    const tokens = value ? parseStoredCodex(value) : null
    const exp = tokens ? accessExpiry(tokens) : null
    return tokens && (exp === null || exp > now) ? tokens.access_token : null
  }
}

// ---- store -----------------------------------------------------------------------------------------

type LeaseRow = {
  user_id: string
  lease_owner: string | null
  lease_until: number | null
  access_expires_at: number | null
  refreshed_at: number | null
  next_attempt_at: number | null
  failures: number
}

/** A fresh broker login: stored as the person's Codex credential, and the refresher's schedule reset. */
export async function storeCodexLogin(
  db: D1Database,
  keyring: Keyring,
  owner: { userId: string; accountId: string },
  tokens: CodexTokens,
  now: number
): Promise<void> {
  await putAgentCredential(
    db,
    keyring,
    { userId: owner.userId, accountId: owner.accountId, agent: 'codex', value: JSON.stringify(tokens), label: codexLabel(tokens), expiresAt: null },
    now
  )
  await db
    .prepare(
      `INSERT INTO codex_leases (user_id, access_expires_at, refreshed_at, next_attempt_at, failures, last_error)
       VALUES (?, ?, ?, NULL, 0, NULL)
       ON CONFLICT (user_id) DO UPDATE SET access_expires_at = excluded.access_expires_at, refreshed_at = excluded.refreshed_at,
         next_attempt_at = NULL, failures = 0, last_error = NULL`
    )
    .bind(owner.userId, accessExpiry(tokens), now)
    .run()
}

// ---- lease refresher -------------------------------------------------------------------------------

export type RefreshDeps = {
  db: D1Database
  keyring: Keyring
  now: () => number
  fetch?: typeof fetch
  /** After a credential changed (refreshed, expired, revoked): drop caches and refresh that person's sandboxes. */
  onChanged?: (userId: string) => Promise<void> | void
}

export type RefreshSummary = { due: number; refreshed: number; failed: number; revoked: number; skipped: number }

/** Persons whose Codex token is due: near expiry, refreshed too long ago, and not backing off or leased. */
async function dueUsers(db: D1Database, now: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT l.user_id FROM codex_leases l
         JOIN agent_credentials c ON c.user_id = l.user_id AND c.agent = 'codex' AND c.state = 'active'
       WHERE (l.access_expires_at IS NULL OR l.access_expires_at <= ? OR l.refreshed_at IS NULL OR l.refreshed_at <= ?)
         AND (l.next_attempt_at IS NULL OR l.next_attempt_at <= ?)
         AND (l.last_error IS NULL OR l.last_error NOT IN (${DEAD_SQL}))
         AND (l.lease_until IS NULL OR l.lease_until <= ?)
       ORDER BY l.access_expires_at LIMIT ?`
    )
    .bind(now + REFRESH_AHEAD_MS, now - REFRESH_EVERY_MS, now, now, BATCH)
    .all<{ user_id: string }>()
  return results.map((r) => r.user_id)
}

async function acquire(db: D1Database, userId: string, owner: string, now: number): Promise<boolean> {
  const result = await db
    .prepare('UPDATE codex_leases SET lease_owner = ?, lease_until = ? WHERE user_id = ? AND (lease_until IS NULL OR lease_until <= ?)')
    .bind(owner, now + LEASE_MS, userId, now)
    .run()
  return result.meta.changes === 1
}

async function release(db: D1Database, userId: string, owner: string, fields: Partial<LeaseRow> & { last_error?: string | null }) {
  const keys = Object.keys(fields)
  await db
    .prepare(
      `UPDATE codex_leases SET lease_owner = NULL, lease_until = NULL${keys.map((k) => `, ${k} = ?`).join('')} WHERE user_id = ? AND lease_owner = ?`
    )
    .bind(...keys.map((k) => (fields as Record<string, unknown>)[k] ?? null), userId, owner)
    .run()
}

type CredentialSnapshot = { value: string; updatedAt: number; accountId: string; label: string | null }

async function readForRefresh(db: D1Database, keyring: Keyring, userId: string): Promise<CredentialSnapshot | null> {
  const row = await db
    .prepare(`SELECT account_id, kek_id, wrapped_dek, ciphertext, label, updated_at, state FROM agent_credentials WHERE user_id = ? AND agent = 'codex'`)
    .bind(userId)
    .first<{ account_id: string; kek_id: string; wrapped_dek: string; ciphertext: string; label: string | null; updated_at: number; state: string }>()
  if (!row || row.state !== 'active') {
    return null
  }
  const value = await keyring.open(credentialBinding(userId, 'codex'), { kekId: row.kek_id, wrappedDek: row.wrapped_dek, ciphertext: row.ciphertext })
  return { value, updatedAt: row.updated_at, accountId: row.account_id, label: row.label }
}

/** Writes the refreshed tokens only over the exact row that was refreshed (compare-and-swap on updated_at). */
async function swapIn(db: D1Database, keyring: Keyring, userId: string, expectedUpdatedAt: number, tokens: CodexTokens, now: number): Promise<boolean> {
  const sealed = await keyring.seal(credentialBinding(userId, 'codex'), JSON.stringify(tokens))
  const result = await db
    .prepare(
      `UPDATE agent_credentials SET kek_id = ?, wrapped_dek = ?, ciphertext = ?, expires_at = NULL, state = 'active', updated_at = ?
       WHERE user_id = ? AND agent = 'codex' AND updated_at = ? AND state = 'active'`
    )
    .bind(sealed.kekId, sealed.wrappedDek, sealed.ciphertext, Math.max(now, expectedUpdatedAt + 1), userId, expectedUpdatedAt)
    .run()
  return result.meta.changes === 1
}

/** Shows the credential as expiring/expired by its real access-token expiry (agent_credentials derives the state). */
async function setExpiry(db: D1Database, userId: string, expectedUpdatedAt: number, expiresAt: number): Promise<void> {
  await db
    .prepare(`UPDATE agent_credentials SET expires_at = ? WHERE user_id = ? AND agent = 'codex' AND updated_at = ?`)
    .bind(expiresAt, userId, expectedUpdatedAt)
    .run()
}

async function revokeIf(db: D1Database, userId: string, expectedUpdatedAt: number, now: number): Promise<void> {
  await db
    .prepare(`UPDATE agent_credentials SET state = 'revoked', updated_at = ? WHERE user_id = ? AND agent = 'codex' AND updated_at = ?`)
    .bind(Math.max(now, expectedUpdatedAt + 1), userId, expectedUpdatedAt)
    .run()
}

/** Token-endpoint error codes that end a login for good (the person must sign in again). */
const DEAD_LOGIN_CODES = ['refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated', 'invalid_grant'] as const
const DEAD_LOGIN: ReadonlySet<string> = new Set(DEAD_LOGIN_CODES)
/** SQL list of the codes above: a dead login is never retried (a new broker login clears last_error). */
const DEAD_SQL = DEAD_LOGIN_CODES.map((code) => `'${code}'`).join(', ')

export type TokenResult =
  | { ok: true; tokens: Partial<CodexTokens> }
  | { ok: false; code: string; permanent: boolean }

/** One refresh call (the same request Codex makes). The reply's tokens are returned, never logged. */
let defaultTokenFetch: typeof fetch = (input, init) => fetch(input, init)
/** Tests only: where refreshes without an explicit fetch (the 401 hook) send their token call. */
export function setCodexTokenFetch(fetcher: typeof fetch | null): void {
  defaultTokenFetch = fetcher ?? ((input, init) => fetch(input, init))
}

export async function requestRefresh(refreshToken: string, fetcher: typeof fetch = defaultTokenFetch): Promise<TokenResult> {
  let response: Response
  try {
    response = await fetcher(CODEX_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken, scope: 'openid profile email' }),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS)
    })
  } catch {
    return { ok: false, code: 'network', permanent: false }
  }
  const body = safeJson(await response.text().catch(() => '')) as Record<string, unknown> | null
  if (response.ok && body && isText(body.access_token)) {
    return {
      ok: true,
      tokens: {
        access_token: body.access_token,
        ...(isText(body.refresh_token) ? { refresh_token: body.refresh_token } : {}),
        ...(isText(body.id_token) ? { id_token: body.id_token } : {})
      }
    }
  }
  // {"error": "code"} or {"error": {"code": "..."}}; only a known code is kept (for the row and the log).
  const raw = body?.error
  const code = typeof raw === 'string' ? raw : typeof (raw as { code?: unknown })?.code === 'string' ? (raw as { code: string }).code : null
  const known = code && /^[a-z_]{1,64}$/.test(code) ? code : `http_${response.status}`
  const permanent = (response.status === 400 || response.status === 401) && DEAD_LOGIN.has(known)
  return { ok: false, code: known, permanent }
}

/** Refreshes one person's Codex token under the lease. Returns what happened (counts only reach logs). */
export async function refreshCodexCredential(deps: RefreshDeps, userId: string): Promise<'refreshed' | 'failed' | 'revoked' | 'skipped'> {
  const { db } = deps
  const owner = crypto.randomUUID()
  const start = deps.now()
  await db.prepare('INSERT OR IGNORE INTO codex_leases (user_id, failures) VALUES (?, 0)').bind(userId).run()
  if (!(await acquire(db, userId, owner, start))) {
    return 'skipped'
  }
  let snapshot: CredentialSnapshot | null = null
  try {
    // Read inside the lease: the refresh token spent is always the newest one written.
    snapshot = await readForRefresh(db, deps.keyring, userId)
    const tokens = snapshot ? parseStoredCodex(snapshot.value) : null
    if (!snapshot || !tokens) {
      await release(db, userId, owner, {})
      return 'skipped'
    }
    const result = await requestRefresh(tokens.refresh_token, deps.fetch)
    const now = deps.now()
    if (result.ok) {
      const next: CodexTokens = { ...tokens, ...result.tokens }
      next.account_id = tokens.account_id ?? (accountIdFrom(next.id_token) ?? null)
      if (!(await swapIn(db, deps.keyring, userId, snapshot.updatedAt, next, now))) {
        // Deleted or replaced by a new login meanwhile: the refreshed tokens belong to nobody now.
        await release(db, userId, owner, {})
        return 'skipped'
      }
      await release(db, userId, owner, { access_expires_at: accessExpiry(next), refreshed_at: now, next_attempt_at: null, failures: 0, last_error: null })
      log('codex_token_refreshed', { userId })
      await deps.onChanged?.(userId)
      return 'refreshed'
    }
    const lease = await db.prepare('SELECT * FROM codex_leases WHERE user_id = ?').bind(userId).first<LeaseRow>()
    const failures = (lease?.failures ?? 0) + 1
    if (result.permanent) {
      // Only the login that was refreshed: a newer broker login written meanwhile stays untouched.
      if (result.code === 'refresh_token_expired') {
        await setExpiry(db, userId, snapshot.updatedAt, now)
      } else {
        await revokeIf(db, userId, snapshot.updatedAt, now)
      }
      await release(db, userId, owner, { failures, last_error: result.code, next_attempt_at: null })
      log('codex_token_dead', { userId, code: result.code })
      await deps.onChanged?.(userId)
      return 'revoked'
    }
    // Transient: back off (1, 2, 4 ... 60 min) and show the real expiry so the state reads expiring/expired.
    const accessExp = accessExpiry(tokens) ?? lease?.access_expires_at ?? now
    await setExpiry(db, userId, snapshot.updatedAt, accessExp)
    await release(db, userId, owner, {
      failures,
      last_error: result.code,
      next_attempt_at: now + Math.min(60, 2 ** (failures - 1)) * 60_000
    })
    log('codex_token_refresh_failed', { userId, code: result.code, failures })
    await deps.onChanged?.(userId)
    return 'failed'
  } catch (error) {
    await release(db, userId, owner, { last_error: 'internal' }).catch(() => undefined)
    log('codex_token_refresh_error', { userId, error: String(error).slice(0, 120) })
    return 'failed'
  }
}

/** Cron: refreshes every due Codex login, one lease per person (single-flight across isolates and ticks). */
export async function refreshCodexLeases(deps: RefreshDeps): Promise<RefreshSummary> {
  const users = await dueUsers(deps.db, deps.now())
  const summary: RefreshSummary = { due: users.length, refreshed: 0, failed: 0, revoked: 0, skipped: 0 }
  for (const userId of users) {
    summary[await refreshCodexCredential(deps, userId)]++
  }
  return summary
}

function log(event: string, fields: Record<string, unknown>) {
  // Ids and error codes only; never a token.
  console.log(JSON.stringify({ event, ...fields }))
}
