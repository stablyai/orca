// Org / personal / repo secret store and its injection into sandbox sessions.
//   GET    /v1/secrets?scope=org|personal|repo[&repo=owner/name]   -> {secrets: [metadata]}
//   PUT    /v1/secrets/:scope/:NAME[?repo=owner/name] {value}       -> {secret: metadata}
//   DELETE /v1/secrets/:scope/:NAME[?repo=owner/name]               -> {deleted: true}
// Values are write-only: no route returns them, only a last-4 hint for long values. Org secrets
// (and repo secrets of an org account) need owner/admin of that org to write; any member may list
// names. Personal secrets belong to the user alone. Values are never logged.
import { z } from 'zod'
import type { SandboxCaller } from './auth'
import type { Env } from './env'
import { createKeyring, type Keyring, type SecretBinding } from './secrets-crypto'
import type { SandboxRow } from './store'

export type SecretScope = 'org' | 'personal' | 'repo'
export type SecretKind = 'env' | 'agent_key'

const NAME = /^[A-Z_][A-Z0-9_]*$/
const MAX_NAME_LENGTH = 128
export const MAX_VALUE_BYTES = 8 * 1024
export const MAX_SECRETS_PER_OWNER = 100
/** Upper bound on what one session start carries (it rides the VM command's env). */
export const MAX_INJECTED_BYTES = 128 * 1024

/** Keys agent CLIs read. For these an org-shared value beats a personal one (Conductor parity). */
export const AGENT_KEY_NAMES: ReadonlySet<string> = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'CURSOR_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_REGION',
  'AWS_BEARER_TOKEN_BEDROCK',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
  'GOOGLE_CLOUD_PROJECT'
])

/** Names that would break or hijack the VM's own processes, or that Orca manages itself. */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'OLDPWD', 'LANG', 'TERM', 'TMPDIR', 'IFS', 'ENV',
  'BASH_ENV', 'PS4', 'PROMPT_COMMAND', 'SHELLOPTS', 'BASHOPTS', 'NODE_OPTIONS', 'NODE_PATH',
  'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'PYTHONPATH', 'PYTHONSTARTUP',
  'PERL5OPT', 'RUBYOPT', 'JAVA_TOOL_OPTIONS', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'GIT_EXEC_PATH',
  'GIT_PROXY_COMMAND', 'SSH_AUTH_SOCK', 'GH_TOKEN', 'GITHUB_TOKEN',
  // Subscription credentials are never stored (Anthropic policy forbids third parties holding them).
  'CLAUDE_CODE_OAUTH_TOKEN'
])
const RESERVED_PREFIXES = ['LD_', 'DYLD_', 'ORCA_', 'VERCEL_', 'BASH_FUNC_', 'GIT_CONFIG']

export class SecretError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    readonly reason?: string
  ) {
    super(reason ? `${code}:${reason}` : code)
    this.name = 'SecretError'
  }
}

export function kindOf(name: string): SecretKind {
  return AGENT_KEY_NAMES.has(name) ? 'agent_key' : 'env'
}

export function checkName(name: string): void {
  if (name.length > MAX_NAME_LENGTH || !NAME.test(name)) {
    throw new SecretError(400, 'invalid_request', 'invalid_name')
  }
  if (name === 'CLAUDE_CODE_OAUTH_TOKEN') {
    throw new SecretError(400, 'invalid_request', 'subscription_token_refused')
  }
  if (RESERVED_NAMES.has(name) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    throw new SecretError(400, 'invalid_request', 'reserved_name')
  }
}

const JWT_SHAPE = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/

/** Refuses Claude.ai / ChatGPT subscription credentials; API keys and ordinary env values pass. */
export function checkValue(name: string, value: string): void {
  if (value.length === 0 || value.includes('\0')) {
    throw new SecretError(400, 'invalid_request', 'invalid_value')
  }
  if (new TextEncoder().encode(value).length > MAX_VALUE_BYTES) {
    throw new SecretError(400, 'invalid_request', 'value_too_large')
  }
  const trimmed = value.trim()
  if (trimmed.startsWith('sk-ant-oat')) {
    throw new SecretError(400, 'invalid_request', 'subscription_token_refused')
  }
  // A ChatGPT/Claude.ai session is a JWT; real Anthropic/OpenAI API keys never are.
  if ((name === 'ANTHROPIC_API_KEY' || name === 'OPENAI_API_KEY') && JWT_SHAPE.test(trimmed)) {
    throw new SecretError(400, 'invalid_request', 'subscription_token_refused')
  }
}

function hintFor(value: string): string | null {
  return value.length >= 16 ? value.slice(-4) : null
}

const REPO_PART = /^[A-Za-z0-9_.-]{1,100}$/

/** `owner/name`, `github.com/owner/name` or an https GitHub URL -> `github.com/owner/name` (lowercase). */
export function normalizeRepo(input: string | null | undefined): string | null {
  if (!input) {
    return null
  }
  const stripped = input
    .trim()
    .replace(/^https:\/\//i, '')
    .replace(/^github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
  const [owner, name, ...rest] = stripped.split('/')
  if (rest.length > 0 || !owner || !name || !REPO_PART.test(owner) || !REPO_PART.test(name)) {
    return null
  }
  return `github.com/${owner}/${name}`.toLowerCase()
}

// Owner ids. Dev operator callers stay inside the `dev:` namespace like their sandboxes do.
const ORG_ACCOUNT = /^(dev:)?org:/
function personalOwner(userId: string, dev: boolean): string {
  return dev ? `dev:user:${userId}` : `user:${userId}`
}
function repoOwner(accountId: string, repo: string): string {
  return `${accountId}#${repo}`
}

/** The owners whose secrets a sandbox session receives. */
export function ownersForSandbox(row: Pick<SandboxRow, 'account_id' | 'user_id' | 'repo_url'>) {
  const repo = normalizeRepo(row.repo_url)
  return {
    org: ORG_ACCOUNT.test(row.account_id) ? row.account_id : null,
    personal: personalOwner(row.user_id, row.account_id.startsWith('dev:')),
    repo: repo ? repoOwner(row.account_id, repo) : null
  }
}

function isOrgAdmin(caller: SandboxCaller): boolean {
  return caller.orgRole === 'owner' || caller.orgRole === 'admin'
}

/** Resolves the owner id for `scope` and checks the caller may read (or write) it. */
export function ownerFor(caller: SandboxCaller, scope: SecretScope, repoParam: string | null, write: boolean): string {
  switch (scope) {
    case 'personal':
      return personalOwner(caller.userId, caller.dev === true)
    case 'org':
      if (!caller.orgId) {
        throw new SecretError(403, 'forbidden', 'no_org')
      }
      if (write && !isOrgAdmin(caller)) {
        throw new SecretError(403, 'forbidden', 'org_admin_required')
      }
      return caller.accountId
    case 'repo': {
      const repo = normalizeRepo(repoParam)
      if (!repo) {
        throw new SecretError(400, 'invalid_request', 'repo_required')
      }
      // Repo secrets belong to the account that owns the workspace: the org (admins write) or the user.
      if (write && caller.orgId && !isOrgAdmin(caller)) {
        throw new SecretError(403, 'forbidden', 'org_admin_required')
      }
      return repoOwner(caller.accountId, repo)
    }
  }
}

type SecretRecord = {
  scope: SecretScope
  owner_id: string
  name: string
  kek_id: string
  wrapped_dek: string
  ciphertext: string
  hint: string | null
  created_at: number
  updated_at: number
  updated_by: string
}

export type SecretView = {
  scope: SecretScope
  name: string
  kind: SecretKind
  hint: string | null
  updatedAt: number
  updatedBy: string
  repo?: string
}

function view(record: Pick<SecretRecord, 'scope' | 'owner_id' | 'name' | 'hint' | 'updated_at' | 'updated_by'>): SecretView {
  const repo = record.scope === 'repo' ? record.owner_id.slice(record.owner_id.indexOf('#') + 1) : undefined
  return {
    scope: record.scope,
    name: record.name,
    kind: kindOf(record.name),
    hint: record.hint,
    updatedAt: record.updated_at,
    updatedBy: record.updated_by,
    ...(repo ? { repo } : {})
  }
}

export async function listSecrets(db: D1Database, scope: SecretScope, ownerId: string): Promise<SecretView[]> {
  const { results } = await db
    .prepare(
      'SELECT scope, owner_id, name, hint, updated_at, updated_by FROM secrets WHERE scope = ? AND owner_id = ? ORDER BY name'
    )
    .bind(scope, ownerId)
    .all<SecretRecord>()
  return results.map(view)
}

export async function putSecret(
  db: D1Database,
  keyring: Keyring,
  input: { scope: SecretScope; ownerId: string; name: string; value: string; updatedBy: string },
  now: number
): Promise<SecretView> {
  checkName(input.name)
  checkValue(input.name, input.value)
  const existing = await db
    .prepare('SELECT name FROM secrets WHERE scope = ? AND owner_id = ? AND name = ?')
    .bind(input.scope, input.ownerId, input.name)
    .first()
  if (!existing) {
    const count = await db
      .prepare('SELECT COUNT(*) AS n FROM secrets WHERE scope = ? AND owner_id = ?')
      .bind(input.scope, input.ownerId)
      .first<{ n: number }>()
    if ((count?.n ?? 0) >= MAX_SECRETS_PER_OWNER) {
      throw new SecretError(409, 'conflict', 'secret_limit')
    }
  }
  const sealed = await keyring.seal({ scope: input.scope, ownerId: input.ownerId, name: input.name }, input.value)
  const hint = hintFor(input.value)
  await db
    .prepare(
      `INSERT INTO secrets (scope, owner_id, name, kek_id, wrapped_dek, ciphertext, hint, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (scope, owner_id, name) DO UPDATE SET kek_id = excluded.kek_id, wrapped_dek = excluded.wrapped_dek,
         ciphertext = excluded.ciphertext, hint = excluded.hint, updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`
    )
    .bind(input.scope, input.ownerId, input.name, sealed.kekId, sealed.wrappedDek, sealed.ciphertext, hint, now, now, input.updatedBy)
    .run()
  return view({ scope: input.scope, owner_id: input.ownerId, name: input.name, hint, updated_at: now, updated_by: input.updatedBy })
}

export async function deleteSecret(db: D1Database, scope: SecretScope, ownerId: string, name: string): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM secrets WHERE scope = ? AND owner_id = ? AND name = ?')
    .bind(scope, ownerId, name)
    .run()
  return result.meta.changes === 1
}

/** Higher wins. Env: repo and personal beat org. Agent keys: org-shared beats repo beats personal. */
const RANK: Record<SecretKind, Record<SecretScope, number>> = {
  env: { repo: 3, personal: 2, org: 1 },
  agent_key: { org: 3, repo: 2, personal: 1 }
}

export type ResolvedSecrets = { env: Record<string, string>; skipped: number }

/** Decrypts every secret the session should see and applies precedence; unreadable rows are skipped. */
export async function resolveSandboxSecrets(
  db: D1Database,
  keyring: Keyring,
  row: Pick<SandboxRow, 'id' | 'account_id' | 'user_id' | 'repo_url'>
): Promise<ResolvedSecrets> {
  const owners = ownersForSandbox(row)
  const pairs: [SecretScope, string][] = [['personal', owners.personal]]
  if (owners.org) {
    pairs.push(['org', owners.org])
  }
  if (owners.repo) {
    pairs.push(['repo', owners.repo])
  }
  const where = pairs.map(() => '(scope = ? AND owner_id = ?)').join(' OR ')
  const { results } = await db
    .prepare(`SELECT * FROM secrets WHERE ${where}`)
    .bind(...pairs.flat())
    .all<SecretRecord>()
  const winners = new Map<string, SecretRecord>()
  for (const record of results) {
    const current = winners.get(record.name)
    const rank = RANK[kindOf(record.name)]
    if (!current || rank[record.scope] > rank[current.scope]) {
      winners.set(record.name, record)
    }
  }
  const env: Record<string, string> = {}
  let bytes = 0
  let skipped = 0
  for (const record of [...winners.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const binding: SecretBinding = { scope: record.scope, ownerId: record.owner_id, name: record.name }
    let value: string
    try {
      value = await keyring.open(binding, {
        kekId: record.kek_id,
        wrappedDek: record.wrapped_dek,
        ciphertext: record.ciphertext
      })
    } catch {
      skipped++
      // Name and scope only: never the value or ciphertext.
      console.log(JSON.stringify({ event: 'secret_unreadable', sandboxId: row.id, scope: record.scope, name: record.name }))
      continue
    }
    bytes += record.name.length + value.length
    if (bytes > MAX_INJECTED_BYTES) {
      skipped++
      console.log(JSON.stringify({ event: 'secret_injection_capped', sandboxId: row.id, name: record.name }))
      continue
    }
    env[record.name] = value
  }
  return { env, skipped }
}

let cachedKeyring: { source: string; keyring: Promise<Keyring> } | null = null

/** The Worker's keyring, or null when SECRETS_KEK is not configured. */
export function keyringFor(env: Env): Promise<Keyring> | null {
  if (!env.SECRETS_KEK) {
    return null
  }
  const source = `${env.SECRETS_KEK_ID ?? 'k1'}\n${env.SECRETS_KEK}\n${env.SECRETS_KEK_RETIRED ?? ''}`
  if (cachedKeyring?.source !== source) {
    const retired = env.SECRETS_KEK_RETIRED ? (JSON.parse(env.SECRETS_KEK_RETIRED) as Record<string, string>) : {}
    cachedKeyring = {
      source,
      keyring: createKeyring({ id: env.SECRETS_KEK_ID ?? 'k1', key: env.SECRETS_KEK }, retired)
    }
  }
  return cachedKeyring.keyring
}

const ScopeSchema = z.enum(['org', 'personal', 'repo'])
const PutSchema = z.object({ value: z.string() }).strict()

/** Routes under /v1/secrets for an authenticated desktop caller. */
export async function handleSecretsRoute(
  request: Request,
  url: URL,
  db: D1Database,
  keyring: Keyring,
  caller: SandboxCaller,
  now: number,
  readJson: (request: Request) => Promise<unknown>
): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
  const match = /^\/v1\/secrets(?:\/([a-z]+)\/([^/]+))?$/.exec(url.pathname)
  if (!match) {
    return json({ error: 'not_found' }, 404)
  }
  const [, scopeSegment, name] = match
  const repoParam = url.searchParams.get('repo')
  if (!scopeSegment) {
    if (request.method !== 'GET') {
      return json({ error: 'not_found' }, 404)
    }
    const scope = ScopeSchema.safeParse(url.searchParams.get('scope') ?? 'personal')
    if (!scope.success) {
      return json({ error: 'invalid_request', reason: 'invalid_scope' }, 400)
    }
    const owner = ownerFor(caller, scope.data, repoParam, false)
    return json({ secrets: await listSecrets(db, scope.data, owner) })
  }
  const scope = ScopeSchema.safeParse(scopeSegment)
  if (!scope.success || !name) {
    return json({ error: 'not_found' }, 404)
  }
  if (request.method === 'PUT') {
    const owner = ownerFor(caller, scope.data, repoParam, true)
    const body = PutSchema.safeParse(await readJson(request))
    if (!body.success) {
      return json({ error: 'invalid_request' }, 400)
    }
    const secret = await putSecret(db, keyring, { scope: scope.data, ownerId: owner, name, value: body.data.value, updatedBy: caller.userId }, now)
    console.log(JSON.stringify({ event: 'secret_written', scope: scope.data, name, by: caller.userId }))
    return json({ secret })
  }
  if (request.method === 'DELETE') {
    const owner = ownerFor(caller, scope.data, repoParam, true)
    checkName(name)
    if (!(await deleteSecret(db, scope.data, owner, name))) {
      return json({ error: 'not_found' }, 404)
    }
    console.log(JSON.stringify({ event: 'secret_deleted', scope: scope.data, name, by: caller.userId }))
    return json({ deleted: true })
  }
  return json({ error: 'not_found' }, 404)
}
