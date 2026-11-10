// Codex broker (agent-accounts spec A2, contract D11, flag S2): a person signs Codex in once, in a short-lived
// broker sandbox, and the control plane keeps the login (codex-credentials.ts).
//   POST /v1/agent-credentials/codex/broker      -> {brokerId, verificationUrl, userCode}
//   GET  /v1/agent-credentials/codex/broker/:id  -> {status: 'pending'|'active'|'failed', error?}
// The broker sandbox boots the golden image with egress limited to OpenAI's sign-in hosts and runs
// `codex login --device-auth` (Codex 0.166). Once the person enters the code, Codex writes auth.json in the
// broker; the Worker reads it through the files API (never a command log), stores it Personal-only and
// deletes the sandbox. Broker sandboxes are infra: no sandboxes row, never billed, tagged `orcaCodexBroker`
// (the workspace orphan sweep skips them) and swept here instead.
import { storeCodexLogin, parseCodexAuthJson } from './codex-credentials'
import type { SandboxCaller } from './auth'
import { goldenFor, type LifecycleDeps } from './lifecycle'
import { SANDBOX_VCPUS } from './machine-size'
import { compileNetworkPolicy } from './network-policy'
import type { Keyring } from './secrets-crypto'

/** Codex device codes last 15 minutes; the broker lives a little longer so a late completion still lands. */
export const BROKER_CODE_TTL_MS = 15 * 60_000
const BROKER_SANDBOX_TIMEOUT_MS = 20 * 60_000
/** A completion that died mid-way (Worker evicted) is retried after this. */
const COMPLETING_STALE_MS = 2 * 60_000
const STARTS_PER_HOUR = 6
const START_TIMEOUT_MS = 60_000
/** Codex's device login talks to auth.openai.com only; chatgpt.com serves the post-login account checks. */
export const BROKER_EGRESS_HOSTS: readonly string[] = ['auth.openai.com', 'chatgpt.com']
const HOME = '/tmp/orca-codex-broker'
export const BROKER_AUTH_PATH = `${HOME}/auth.json`
export const BROKER_EXIT_PATH = `${HOME}/exit`
export const BROKER_START_MARKER = 'orca-codex-broker-start'

/**
 * Starts the device login detached (its own session, all fds redirected, so the command returns) and waits
 * up to 25 s for Codex to print the link and code. Prints the login's output (no token is ever printed by
 * `codex login`), ANSI stripped. `cli_auth_credentials_store="file"` keeps the result in auth.json on Linux.
 */
export const BROKER_START_SCRIPT = `set -u
d=${HOME}
rm -rf "$d"; mkdir -m 700 -p "$d"; cd "$d"
CODEX_HOME="$d" setsid nohup bash -lc 'codex login -c cli_auth_credentials_store="file" --device-auth; echo $? > "$CODEX_HOME/exit"' </dev/null >"$d/login.log" 2>&1 &
for _ in $(seq 1 50); do
  if grep -q 'https://' "$d/login.log" 2>/dev/null && grep -Eq '[A-Z0-9]{4,}-[A-Z0-9]{4,}' "$d/login.log" 2>/dev/null; then break; fi
  [ -f "$d/exit" ] && break
  sleep 0.5
done
echo ${BROKER_START_MARKER}
sed 's/\\x1b\\[[0-9;?]*[A-Za-z]//g' "$d/login.log" 2>/dev/null | head -c 4000
`

export type BrokerStatus = 'starting' | 'pending' | 'completing' | 'active' | 'failed'
export type BrokerRow = {
  id: string
  user_id: string
  account_id: string
  provider_name: string
  session_id: string | null
  status: BrokerStatus
  verification_url: string | null
  user_code: string | null
  error: string | null
  created_at: number
  updated_at: number
  expires_at: number
  destroyed_at: number | null
}

export class CodexBrokerError extends Error {
  constructor(
    readonly status: 400 | 404 | 429 | 502 | 503,
    readonly code: string
  ) {
    super(code)
  }
}

export type BrokerDeps = {
  life: Pick<LifecycleDeps, 'db' | 'provider' | 'config' | 'now'>
  keyring: Keyring
  /** After a login landed: drop caches and refresh the person's running sandboxes. */
  onStored?: (userId: string) => Promise<void> | void
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
const URL_RE = /https:\/\/auth\.openai\.com\/[A-Za-z0-9/_?=&.-]*/
const CODE_RE = /\b[A-Z0-9]{4,8}-[A-Z0-9]{4,8}\b/

/** The verification link and one-time code from `codex login --device-auth` output. */
export function parseDeviceCode(output: string): { verificationUrl: string; userCode: string } | null {
  const text = output.replace(ANSI, '')
  const url = URL_RE.exec(text)?.[0]
  const code = CODE_RE.exec(text.slice(text.indexOf(BROKER_START_MARKER) + 1))?.[0]
  return url && code ? { verificationUrl: url.replace(/[.,]+$/, ''), userCode: code } : null
}

function log(event: string, fields: Record<string, unknown>) {
  // Ids and codes of errors only: never a token, never the user code.
  console.log(JSON.stringify({ event, ...fields }))
}

async function getRow(db: D1Database, id: string): Promise<BrokerRow | null> {
  return db.prepare('SELECT * FROM codex_broker_sessions WHERE id = ?').bind(id).first<BrokerRow>()
}

async function update(db: D1Database, id: string, fields: Partial<BrokerRow>, now: number, onlyFrom?: BrokerStatus): Promise<boolean> {
  const keys = Object.keys(fields)
  const result = await db
    .prepare(
      `UPDATE codex_broker_sessions SET updated_at = ?${keys.map((k) => `, ${k} = ?`).join('')} WHERE id = ?${onlyFrom ? ' AND status = ?' : ''}`
    )
    .bind(now, ...keys.map((k) => (fields as Record<string, unknown>)[k] ?? null), id, ...(onlyFrom ? [onlyFrom] : []))
    .run()
  return result.meta.changes === 1
}

async function destroy(deps: BrokerDeps, row: BrokerRow): Promise<void> {
  try {
    await deps.life.provider.deleteSandbox(row.provider_name)
    await update(deps.life.db, row.id, { destroyed_at: deps.life.now() }, deps.life.now())
  } catch (error) {
    // The sweep retries until the sandbox is gone.
    log('codex_broker_destroy_failed', { brokerId: row.id, error: String(error).slice(0, 120) })
  }
}

async function fail(deps: BrokerDeps, row: BrokerRow, error: string): Promise<BrokerRow> {
  await update(deps.life.db, row.id, { status: 'failed', error }, deps.life.now())
  log('codex_broker_failed', { brokerId: row.id, userId: row.user_id, error })
  await destroy(deps, row)
  return { ...row, status: 'failed', error }
}

/** POST: a broker sandbox with a device code for this person (a live one is reused). */
export async function startCodexBroker(
  deps: BrokerDeps,
  caller: Pick<SandboxCaller, 'userId' | 'accountId'>
): Promise<{ brokerId: string; verificationUrl: string; userCode: string; expiresAt: number }> {
  const { db, provider, config } = deps.life
  const now = deps.life.now()
  const live = await db
    .prepare(
      `SELECT * FROM codex_broker_sessions WHERE user_id = ? AND status = 'pending' AND destroyed_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .bind(caller.userId, now + 2 * 60_000)
    .first<BrokerRow>()
  if (live?.verification_url && live.user_code) {
    return { brokerId: live.id, verificationUrl: live.verification_url, userCode: live.user_code, expiresAt: live.expires_at }
  }
  const recent = await db
    .prepare('SELECT COUNT(*) AS n FROM codex_broker_sessions WHERE user_id = ? AND created_at > ?')
    .bind(caller.userId, now - 60 * 60_000)
    .first<{ n: number }>()
  if ((recent?.n ?? 0) >= STARTS_PER_HOUR) {
    throw new CodexBrokerError(429, 'rate_limited')
  }
  const region = config.defaultRegion
  const snapshotId = goldenFor(deps.life, region)
  if (!snapshotId) {
    throw new CodexBrokerError(503, 'no_golden_image')
  }
  const id = `cxb_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
  const row: BrokerRow = {
    id,
    user_id: caller.userId,
    account_id: caller.accountId,
    provider_name: `orca-${config.environment}-codexbroker-${id}`,
    session_id: null,
    status: 'starting',
    verification_url: null,
    user_code: null,
    error: null,
    created_at: now,
    updated_at: now,
    expires_at: now + BROKER_CODE_TTL_MS,
    destroyed_at: null
  }
  await db
    .prepare(
      `INSERT INTO codex_broker_sessions (id, user_id, account_id, provider_name, status, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, 'starting', ?, ?, ?)`
    )
    .bind(row.id, row.user_id, row.account_id, row.provider_name, now, now, row.expires_at)
    .run()
  let output: string
  try {
    const state = await provider.createSandbox({
      name: row.provider_name,
      snapshotId,
      vcpus: SANDBOX_VCPUS,
      region,
      timeoutMs: BROKER_SANDBOX_TIMEOUT_MS,
      ports: [],
      networkPolicy: compileNetworkPolicy({ mode: 'allowlist', allowlist: BROKER_EGRESS_HOSTS }),
      // Infra, not a workspace: no orcaSandbox tag (the workspace orphan sweep and billing never see it).
      tags: { orcaCodexBroker: id, orcaEnv: config.environment, orcaInfra: 'codex-broker' },
      snapshotExpirationMs: 0,
      persistent: false
    })
    row.session_id = state.session.id
    await update(db, id, { session_id: row.session_id }, deps.life.now())
    const started = await provider.runCommand(row.session_id, { command: 'bash', args: ['-c', BROKER_START_SCRIPT], timeoutMs: START_TIMEOUT_MS })
    output = started.stdout
  } catch (error) {
    await fail(deps, row, 'broker_start_failed')
    log('codex_broker_start_error', { brokerId: id, error: String(error).slice(0, 160) })
    throw new CodexBrokerError(502, 'broker_unavailable')
  }
  const code = parseDeviceCode(output)
  if (!code) {
    // e.g. "device code login is not enabled": first line only, so a support ticket has something to go on.
    const reason = /not enabled/i.test(output) ? 'device_auth_disabled' : 'no_device_code'
    await fail(deps, row, reason)
    throw new CodexBrokerError(502, reason)
  }
  await update(db, id, { status: 'pending', verification_url: code.verificationUrl, user_code: code.userCode }, deps.life.now(), 'starting')
  log('codex_broker_started', { brokerId: id, userId: caller.userId, ms: deps.life.now() - now })
  return { brokerId: id, ...code, expiresAt: row.expires_at }
}

/**
 * Moves one broker on: a finished login is stored and its sandbox deleted; an expired or failed one is
 * cleaned up. Safe to call concurrently (GET polls and the cron): only one caller completes a login.
 */
export async function advanceCodexBroker(deps: BrokerDeps, row: BrokerRow): Promise<BrokerRow> {
  const { db, provider } = deps.life
  const now = deps.life.now()
  if (row.status === 'active' || row.status === 'failed') {
    if (row.destroyed_at === null) {
      await destroy(deps, row)
    }
    return row
  }
  if (row.status === 'completing' && now - row.updated_at < COMPLETING_STALE_MS) {
    return row
  }
  if (row.status === 'starting') {
    // The POST that owns it is still running, or died: a stale one is failed by its expiry below.
    return now > row.expires_at ? fail(deps, row, 'expired') : row
  }
  if (!row.session_id) {
    return fail(deps, row, 'broker_lost')
  }
  let auth: string | null
  let exit: string | null
  try {
    auth = await provider.readFile(row.session_id, BROKER_AUTH_PATH)
    exit = auth ? null : await provider.readFile(row.session_id, BROKER_EXIT_PATH)
  } catch {
    // The broker sandbox is gone (timed out or deleted) before the login finished.
    return now > row.expires_at ? fail(deps, row, 'expired') : fail(deps, row, 'broker_lost')
  }
  if (!auth) {
    if (exit !== null) {
      return fail(deps, row, 'login_failed')
    }
    return now > row.expires_at ? fail(deps, row, 'expired') : row
  }
  // Claim the completion: exactly one caller stores this login (a second store would put back a refresh
  // token the refresher may already have spent).
  if (!(await update(db, row.id, { status: 'completing' }, now, row.status))) {
    return (await getRow(db, row.id)) ?? row
  }
  const tokens = parseCodexAuthJson(auth)
  auth = null
  if (!tokens) {
    return fail(deps, { ...row, status: 'completing' }, 'not_a_chatgpt_login')
  }
  try {
    await storeCodexLogin(db, deps.keyring, { userId: row.user_id, accountId: row.account_id }, tokens, deps.life.now())
  } catch (error) {
    log('codex_broker_store_error', { brokerId: row.id, error: String(error).slice(0, 120) })
    return fail(deps, { ...row, status: 'completing' }, 'store_failed')
  }
  await update(db, row.id, { status: 'active', user_code: null }, deps.life.now())
  log('codex_broker_active', { brokerId: row.id, userId: row.user_id, ms: deps.life.now() - row.created_at })
  const done: BrokerRow = { ...row, status: 'active', user_code: null }
  await destroy(deps, done)
  await deps.onStored?.(row.user_id)
  return done
}

/** GET: this person's broker, advanced first so polling alone completes the login. */
export async function codexBrokerStatus(deps: BrokerDeps, userId: string, id: string): Promise<{ status: 'pending' | 'active' | 'failed'; error?: string }> {
  const row = await getRow(deps.life.db, id)
  if (!row || row.user_id !== userId) {
    throw new CodexBrokerError(404, 'not_found')
  }
  const next = await advanceCodexBroker(deps, row)
  const status = next.status === 'active' ? 'active' : next.status === 'failed' ? 'failed' : 'pending'
  return status === 'failed' && next.error ? { status, error: next.error } : { status }
}

/** DELETE (the card's Cancel): the device code dies with its sandbox. A finished login is left alone. */
export async function cancelCodexBroker(deps: BrokerDeps, userId: string, id: string): Promise<{ status: 'pending' | 'active' | 'failed'; error?: string }> {
  const row = await getRow(deps.life.db, id)
  if (!row || row.user_id !== userId) {
    throw new CodexBrokerError(404, 'not_found')
  }
  if (row.status === 'active') {
    return { status: 'active' }
  }
  if (row.status === 'completing' && deps.life.now() - row.updated_at < COMPLETING_STALE_MS) {
    // Mid-store: the login lands; cancelling now would only race it.
    return { status: 'pending' }
  }
  if (row.status !== 'failed' && !(await update(deps.life.db, row.id, { status: 'failed', error: 'cancelled', user_code: null }, deps.life.now(), row.status))) {
    return cancelCodexBroker(deps, userId, id)
  }
  if (row.destroyed_at === null) {
    await destroy(deps, row)
  }
  log('codex_broker_cancelled', { brokerId: row.id, userId })
  const error = row.status === 'failed' ? (row.error ?? 'failed') : 'cancelled'
  return { status: 'failed', error }
}

/**
 * Cron: advances live brokers (a login completes even if the desktop stopped polling), retries deletes,
 * and, with `sweepProvider`, deletes broker sandboxes D1 no longer accounts for (a POST that died mid-create).
 */
export async function codexBrokerTick(deps: BrokerDeps, options: { sweepProvider?: boolean } = {}): Promise<{ advanced: number; leaked: number }> {
  const { db, provider, config } = deps.life
  const { results } = await db
    .prepare('SELECT * FROM codex_broker_sessions WHERE destroyed_at IS NULL ORDER BY created_at LIMIT 50')
    .all<BrokerRow>()
  for (const row of results) {
    await advanceCodexBroker(deps, row).catch((error: unknown) =>
      log('codex_broker_tick_error', { brokerId: row.id, error: String(error).slice(0, 120) })
    )
  }
  let leaked = 0
  if (options.sweepProvider) {
    const listing = await provider.listSandboxes()
    for (const box of listing.sandboxes) {
      if (box.tags.orcaEnv !== config.environment || !box.tags.orcaCodexBroker) {
        continue
      }
      const row = await getRow(db, box.tags.orcaCodexBroker)
      // Live brokers are the loop above's; anything else (destroyed, unknown, past its sandbox timeout) goes.
      if (row && row.destroyed_at === null && deps.life.now() - row.created_at < BROKER_SANDBOX_TIMEOUT_MS) {
        continue
      }
      await provider.deleteSandbox(box.name).catch(() => undefined)
      leaked++
      log('codex_broker_leak_deleted', { name: box.name })
    }
  }
  return { advanced: results.length, leaked }
}

/** Routes under /v1/agent-credentials/codex/broker; `deps` is null when the control plane can't start VMs. */
export async function handleCodexBrokerRoute(
  request: Request,
  url: URL,
  options: { enabled: boolean; deps: BrokerDeps | null; caller: Pick<SandboxCaller, 'userId' | 'accountId'> }
): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
  // Flag S2 off or the kill switch on: no new logins (a stored one is left alone; DELETE still works).
  if (!options.enabled) {
    return json({ error: 'not_found' }, 404)
  }
  if (!options.deps) {
    return json({ error: 'not_configured' }, 503)
  }
  try {
    if (request.method === 'POST' && url.pathname === '/v1/agent-credentials/codex/broker') {
      return json(await startCodexBroker(options.deps, options.caller))
    }
    const match = /^\/v1\/agent-credentials\/codex\/broker\/(cxb_[a-f0-9]{20})$/.exec(url.pathname)
    if (request.method === 'GET' && match) {
      return json(await codexBrokerStatus(options.deps, options.caller.userId, match[1]!))
    }
    if (request.method === 'DELETE' && match) {
      return json(await cancelCodexBroker(options.deps, options.caller.userId, match[1]!))
    }
    return json({ error: 'not_found' }, 404)
  } catch (error) {
    if (error instanceof CodexBrokerError) {
      return json({ error: error.code }, error.status)
    }
    throw error
  }
}
