// Org-scoped API keys. A key is `orca_<kind tag>_<32 random base62>`; only its SHA-256 is stored,
// so a D1 leak yields nothing usable. Lookup is by hash (unique index), which is constant-work per
// request and never compares secrets byte by byte.
import type { OrgRole } from '../auth'

export const API_SCOPES = [
  'workspaces:read',
  'workspaces:write',
  'messages:write',
  'projects:read',
  'projects:write',
  'routines:read',
  'routines:write',
  'audit:read'
] as const
export type ApiScope = (typeof API_SCOPES)[number]

/** Scopes only an org owner/admin may grant (personal accounts are their own admin). */
export const ADMIN_SCOPES: ReadonlySet<ApiScope> = new Set(['audit:read'])

/** What the in-VM CLI token may do: look at and create sibling workspaces, message agents. */
export const WORKSPACE_TOKEN_SCOPES: readonly ApiScope[] = ['workspaces:read', 'workspaces:write', 'messages:write', 'projects:read']

export type ApiKeyKind = 'user' | 'workspace' | 'oauth' | 'oauth_refresh'

export type ApiKeyRow = {
  id: string
  account_id: string
  created_by: string
  creator_role: OrgRole | null
  name: string
  prefix: string
  secret_hash: string
  scopes: string
  kind: ApiKeyKind
  sandbox_id: string | null
  expires_at: number | null
  last_used_at: number | null
  created_at: number
  revoked_at: number | null
  revoked_by: string | null
  /** MCP OAuth tokens (migration 0022): the registered client, the resource (RFC 8707) and the grant family. */
  client_id?: string | null
  audience?: string | null
  family_id?: string | null
}

const TAG: Record<ApiKeyKind, string> = { user: 'sk', workspace: 'ws', oauth: 'oat', oauth_refresh: 'ort' }
const KEY_PATTERN = /^orca_(sk|ws|oat|ort)_[A-Za-z0-9]{32}$/
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
/** last_used_at is a hint, not an audit record: write it at most once a minute per key. */
const LAST_USED_GRANULARITY_MS = 60_000

export function looksLikeApiKey(value: string): boolean {
  return KEY_PATTERN.test(value)
}

export function randomToken(length: number): string {
  // Rejection sampling keeps every character uniform (256 is not a multiple of 62).
  let out = ''
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < 248 && out.length < length) {
        out += BASE62[byte % 62]
      }
    }
  }
  return out
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomToken(20)}`
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function parseScopes(value: string): ApiScope[] {
  const known = new Set<string>(API_SCOPES)
  return value.split(/[\s,]+/).filter((scope): scope is ApiScope => known.has(scope))
}

export type MintedKey = { row: ApiKeyRow; secret: string }

export async function mintApiKey(
  db: D1Database,
  input: {
    accountId: string
    createdBy: string
    creatorRole?: OrgRole | null
    name: string
    scopes: readonly ApiScope[]
    kind?: ApiKeyKind
    sandboxId?: string | null
    expiresAt?: number | null
    oauth?: { clientId: string; audience: string; familyId: string }
  },
  now: number
): Promise<MintedKey> {
  const kind = input.kind ?? 'user'
  const secret = `orca_${TAG[kind]}_${randomToken(32)}`
  const row: ApiKeyRow = {
    id: randomId('key'),
    account_id: input.accountId,
    created_by: input.createdBy,
    creator_role: input.creatorRole ?? null,
    name: input.name,
    // `orca_sk_AbCd…` identifies a key in lists and leaked-secret scans without revealing it.
    prefix: secret.slice(0, secret.indexOf('_', 5) + 5),
    secret_hash: await sha256Hex(secret),
    scopes: [...new Set(input.scopes)].join(' '),
    kind,
    sandbox_id: input.sandboxId ?? null,
    expires_at: input.expiresAt ?? null,
    last_used_at: null,
    created_at: now,
    revoked_at: null,
    revoked_by: null,
    client_id: input.oauth?.clientId ?? null,
    audience: input.oauth?.audience ?? null,
    family_id: input.oauth?.familyId ?? null
  }
  await db
    .prepare(
      `INSERT INTO api_keys (id, account_id, created_by, creator_role, name, prefix, secret_hash, scopes, kind,
         sandbox_id, expires_at, created_at${row.client_id ? ', client_id, audience, family_id' : ''})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${row.client_id ? ', ?, ?, ?' : ''})`
    )
    .bind(row.id, row.account_id, row.created_by, row.creator_role, row.name, row.prefix, row.secret_hash,
      row.scopes, row.kind, row.sandbox_id, row.expires_at, row.created_at,
      ...(row.client_id ? [row.client_id, row.audience, row.family_id] : []))
    .run()
  return { row, secret }
}

/** The live key for a presented secret, or null (unknown, revoked or expired). */
export async function resolveApiKey(db: D1Database, secret: string, now: number): Promise<ApiKeyRow | null> {
  if (!looksLikeApiKey(secret)) {
    return null
  }
  const row = await db
    .prepare('SELECT * FROM api_keys WHERE secret_hash = ?')
    .bind(await sha256Hex(secret))
    .first<ApiKeyRow>()
  if (!row || row.revoked_at !== null || (row.expires_at !== null && row.expires_at <= now)) {
    return null
  }
  if (row.last_used_at === null || now - row.last_used_at >= LAST_USED_GRANULARITY_MS) {
    await db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').bind(now, row.id).run()
  }
  return row
}

export async function listApiKeys(
  db: D1Database,
  accountId: string,
  filter: { createdBy?: string } = {}
): Promise<ApiKeyRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM api_keys WHERE account_id = ? AND kind = 'user' AND revoked_at IS NULL
       ${filter.createdBy ? 'AND created_by = ?' : ''} ORDER BY created_at DESC LIMIT 200`
    )
    .bind(accountId, ...(filter.createdBy ? [filter.createdBy] : []))
    .all<ApiKeyRow>()
  return results
}

export function getApiKey(db: D1Database, id: string): Promise<ApiKeyRow | null> {
  return db.prepare('SELECT * FROM api_keys WHERE id = ?').bind(id).first<ApiKeyRow>()
}

export async function revokeApiKey(db: D1Database, id: string, by: string, now: number): Promise<boolean> {
  const result = await db
    .prepare('UPDATE api_keys SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL')
    .bind(now, by, id)
    .run()
  return result.meta.changes === 1
}

/** Workspace tokens die with their session: revoked on every new boot, suspend and destroy. */
export async function revokeWorkspaceTokens(db: D1Database, sandboxId: string, now: number): Promise<void> {
  await db
    .prepare(`UPDATE api_keys SET revoked_at = ?, revoked_by = 'system' WHERE sandbox_id = ? AND kind = 'workspace' AND revoked_at IS NULL`)
    .bind(now, sandboxId)
    .run()
}

export function apiKeyView(row: ApiKeyRow) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes.split(' ').filter(Boolean),
    createdBy: row.created_by,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at
  }
}
