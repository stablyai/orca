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
import { BASE_URL_NAMES, baseUrlHost } from './provider-env'
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
  'GOOGLE_CLOUD_PROJECT',
  // Provider presets and custom endpoints travel with their key, so an org-shared pair wins as a pair.
  'AI_GATEWAY_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL'
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
  if ((BASE_URL_NAMES.has(name) || name.endsWith('_MODEL')) && !/^[\x21-\x7e]+$/.test(value)) {
    // URLs and model ids land in client config (Codex TOML, Claude Code): no spaces or control characters.
    throw new SecretError(400, 'invalid_request', BASE_URL_NAMES.has(name) ? 'invalid_base_url' : 'invalid_value')
  }
  if (BASE_URL_NAMES.has(name) && !baseUrlHost(trimmed)) {
    // The VM's egress allowlist opens this host, so only public https endpoints are accepted.
    throw new SecretError(400, 'invalid_request', 'invalid_base_url')
  }
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

/** `scopes`: which scope each injected name came from (provenance for egress routing). */
export type ResolvedSecrets = { env: Record<string, string>; scopes: Record<string, SecretScope>; skipped: number }

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
  const scopes: Record<string, SecretScope> = {}
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
    scopes[record.name] = record.scope
  }
  return { env, scopes, skipped }
}

export type EffectiveSecret = {
  name: string
  kind: SecretKind
  /** The scope whose value a session gets. */
  scope: SecretScope
  hint: string | null
  updatedAt: number
  /** Same-name values that lose to `scope`, highest rank first. */
  shadowed: { scope: SecretScope; hint: string | null }[]
}

export const PRECEDENCE: Record<SecretKind, SecretScope[]> = {
  env: ['repo', 'personal', 'org'],
  agent_key: ['org', 'repo', 'personal']
}

/** What a session of this caller (in `repo`) would receive, by name and winning scope; no values. */
export async function effectiveSecrets(db: D1Database, caller: SandboxCaller, repoParam: string | null): Promise<EffectiveSecret[]> {
  const pairs: [SecretScope, string][] = [['personal', personalOwner(caller.userId, caller.dev === true)]]
  if (caller.orgId) {
    pairs.push(['org', caller.accountId])
  }
  const repo = normalizeRepo(repoParam)
  if (repo) {
    pairs.push(['repo', repoOwner(caller.accountId, repo)])
  }
  const where = pairs.map(() => '(scope = ? AND owner_id = ?)').join(' OR ')
  const { results } = await db
    .prepare(`SELECT scope, owner_id, name, hint, updated_at, updated_by FROM secrets WHERE ${where}`)
    .bind(...pairs.flat())
    .all<SecretRecord>()
  const byName = new Map<string, SecretRecord[]>()
  for (const record of results) {
    byName.set(record.name, [...(byName.get(record.name) ?? []), record])
  }
  return [...byName.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, records]) => {
      const kind = kindOf(name)
      const rank = RANK[kind]
      const [winner, ...rest] = records.sort((a, b) => rank[b.scope] - rank[a.scope])
      return {
        name,
        kind,
        scope: winner!.scope,
        hint: winner!.hint,
        updatedAt: winner!.updated_at,
        shadowed: rest.map((record) => ({ scope: record.scope, hint: record.hint }))
      }
    })
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
const MAX_BATCH = 100
const BatchSchema = z
  .object({
    set: z.record(z.string().max(MAX_NAME_LENGTH), z.string()).optional(),
    delete: z.array(z.string().max(MAX_NAME_LENGTH)).max(MAX_BATCH).optional()
  })
  .strict()
  .refine((body) => Object.keys(body.set ?? {}).length + (body.delete?.length ?? 0) <= MAX_BATCH)

export type SecretChange = { scope: SecretScope; ownerId: string }

/** Routes under /v1/secrets for an authenticated desktop caller. */
export async function handleSecretsRoute(
  request: Request,
  url: URL,
  db: D1Database,
  keyring: Keyring,
  caller: SandboxCaller,
  now: number,
  readJson: (request: Request) => Promise<unknown>,
  /** Called after a write lands, so running sessions of that owner can pick it up. */
  onChange: (change: SecretChange) => void = () => {}
): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
  const repoQuery = url.searchParams.get('repo')
  if (url.pathname === '/v1/secrets/effective') {
    if (request.method !== 'GET') {
      return json({ error: 'not_found' }, 404)
    }
    const admin = isOrgAdmin(caller)
    return json({
      caller: {
        userId: caller.userId,
        orgId: caller.orgId ?? null,
        orgRole: caller.orgRole ?? null,
        canWrite: { personal: true, org: Boolean(caller.orgId) && admin, repo: !caller.orgId || admin }
      },
      precedence: PRECEDENCE,
      secrets: await effectiveSecrets(db, caller, repoQuery)
    })
  }
  const batchMatch = /^\/v1\/secrets\/([a-z]+)\/batch$/.exec(url.pathname)
  if (batchMatch) {
    const scope = ScopeSchema.safeParse(batchMatch[1])
    if (!scope.success || request.method !== 'POST') {
      return json({ error: 'not_found' }, 404)
    }
    const owner = ownerFor(caller, scope.data, repoQuery, true)
    const body = BatchSchema.safeParse(await readJson(request))
    if (!body.success) {
      return json({ error: 'invalid_request' }, 400)
    }
    const written: SecretView[] = []
    const deleted: string[] = []
    const errors: { name: string; error: string; reason?: string }[] = []
    const attempt = async (name: string, run: () => Promise<void>) => {
      try {
        await run()
      } catch (error) {
        if (!(error instanceof SecretError)) {
          throw error
        }
        errors.push({ name: name.slice(0, MAX_NAME_LENGTH), error: error.code, ...(error.reason ? { reason: error.reason } : {}) })
      }
    }
    for (const [name, value] of Object.entries(body.data.set ?? {})) {
      await attempt(name, async () => {
        written.push(await putSecret(db, keyring, { scope: scope.data, ownerId: owner, name, value, updatedBy: caller.userId }, now))
      })
    }
    for (const name of body.data.delete ?? []) {
      await attempt(name, async () => {
        checkName(name)
        if (await deleteSecret(db, scope.data, owner, name)) {
          deleted.push(name)
        }
      })
    }
    // Names only.
    console.log(JSON.stringify({ event: 'secrets_batch', scope: scope.data, written: written.map((s) => s.name), deleted, failed: errors.length, by: caller.userId }))
    if (written.length > 0 || deleted.length > 0) {
      onChange({ scope: scope.data, ownerId: owner })
    }
    return json({ secrets: written, deleted, errors })
  }
  const match = /^\/v1\/secrets(?:\/([a-z]+)\/([^/]+))?$/.exec(url.pathname)
  if (!match) {
    return json({ error: 'not_found' }, 404)
  }
  const [, scopeSegment, name] = match
  const repoParam = repoQuery
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
    onChange({ scope: scope.data, ownerId: owner })
    return json({ secret })
  }
  if (request.method === 'DELETE') {
    const owner = ownerFor(caller, scope.data, repoParam, true)
    checkName(name)
    if (!(await deleteSecret(db, scope.data, owner, name))) {
      return json({ error: 'not_found' }, 404)
    }
    console.log(JSON.stringify({ event: 'secret_deleted', scope: scope.data, name, by: caller.userId }))
    onChange({ scope: scope.data, ownerId: owner })
    return json({ deleted: true })
  }
  return json({ error: 'not_found' }, 404)
}
