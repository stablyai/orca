// D1 access and API views for routines and their runs (tables: migrations/0020 + 0021).
import type { MachineSize } from '../entitlements'
import { randomId, randomToken, sha256Hex } from '../api/keys'
import type { AgentId } from '../api/vm-agent'

export const GITHUB_EVENTS = [
  'pull_request.opened',
  'pull_request.labeled',
  'pull_request.synchronize',
  'issues.opened',
  'issues.labeled',
  'issue_comment.created'
] as const
export type GitHubEventKey = (typeof GITHUB_EVENTS)[number]

export type TriggerKind = 'schedule' | 'github' | 'webhook'
export type RunTrigger = TriggerKind | 'manual'
export type PostResults = 'none' | 'comment' | 'pr'
export type RunStatus = 'queued' | 'starting' | 'running' | 'posting' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out'

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['starting', 'running', 'posting']
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled', 'timed_out']

export type ScheduleConfig = { cron: string; timezone: string }
export type GitHubConfig = { events: GitHubEventKey[]; labels?: string[]; authors?: string[]; baseBranches?: string[] }
export type TriggerConfig =
  | ({ kind: 'schedule' } & ScheduleConfig)
  | ({ kind: 'github' } & GitHubConfig)
  | { kind: 'webhook' }

export type RoutineRow = {
  id: string
  account_id: string
  created_by: string
  name: string
  project_id: string
  enabled: number
  trigger_kind: TriggerKind
  trigger_config: string
  webhook_id: string | null
  webhook_secret_hash: string | null
  webhook_hint: string | null
  agent: AgentId
  prompt: string
  machine_size: MachineSize
  post_results: PostResults
  max_runtime_ms: number
  next_run_at: number | null
  last_run_at: number | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

/** A routine with what its views and runs need from the project and the latest run. */
export type RoutineRecord = RoutineRow & {
  repo_url: string | null
  default_ref: string | null
  last_run_id: string | null
  last_run_status: RunStatus | null
  last_run_finished_at: number | null
}

export type RunResult = {
  summary?: string
  prUrl?: string
  commentUrl?: string
  exitCode?: number
  branch?: string
}

export type RunRow = {
  id: string
  routine_id: string
  account_id: string
  trigger_kind: RunTrigger
  trigger_detail: string | null
  dedupe_key: string | null
  status: RunStatus
  sandbox_id: string | null
  result: string | null
  error: string | null
  log_tail: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
  updated_at: number
}

function parseJson<T>(value: string | null): T | null {
  if (!value) {
    return null
  }
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

export function triggerConfig(row: Pick<RoutineRow, 'trigger_kind' | 'trigger_config'>): TriggerConfig {
  const config = parseJson<Record<string, unknown>>(row.trigger_config) ?? {}
  return { ...config, kind: row.trigger_kind } as TriggerConfig
}

export function routineView(row: RoutineRecord) {
  const trigger = triggerConfig(row)
  return {
    id: row.id,
    name: row.name,
    projectId: row.project_id,
    repo: row.repo_url ? { url: row.repo_url, ref: row.default_ref } : null,
    enabled: row.enabled === 1,
    trigger: trigger.kind === 'webhook' ? { kind: 'webhook' as const, urlHint: row.webhook_hint ? `…${row.webhook_hint}` : null } : trigger,
    agent: row.agent,
    prompt: row.prompt,
    postResults: row.post_results,
    machineSize: row.machine_size,
    maxRuntimeMinutes: Math.round(row.max_runtime_ms / 60_000),
    nextRunAt: row.enabled === 1 && row.trigger_kind === 'schedule' ? row.next_run_at : null,
    lastRun: row.last_run_id ? { id: row.last_run_id, status: row.last_run_status, finishedAt: row.last_run_finished_at } : null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function runResult(row: Pick<RunRow, 'result'>): RunResult | null {
  return parseJson<RunResult>(row.result)
}

export function runView(row: RunRow, options: { logTail?: boolean } = {}) {
  const result = runResult(row)
  return {
    id: row.id,
    routineId: row.routine_id,
    trigger: row.trigger_kind,
    triggerDetail: parseJson<Record<string, unknown>>(row.trigger_detail),
    status: row.status,
    workspaceId: row.sandbox_id,
    result: result
      ? {
          ...(result.summary ? { summary: result.summary } : {}),
          ...(result.prUrl ? { prUrl: result.prUrl } : {}),
          ...(result.commentUrl ? { commentUrl: result.commentUrl } : {})
        }
      : null,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.started_at !== null && row.finished_at !== null ? row.finished_at - row.started_at : null,
    ...(options.logTail ? { logTail: row.log_tail } : {})
  }
}

const RECORD_SELECT = `SELECT r.*, p.repo_url AS repo_url, p.default_ref AS default_ref,
  (SELECT id FROM routine_runs x WHERE x.routine_id = r.id ORDER BY x.created_at DESC, x.id DESC LIMIT 1) AS last_run_id,
  (SELECT status FROM routine_runs x WHERE x.routine_id = r.id ORDER BY x.created_at DESC, x.id DESC LIMIT 1) AS last_run_status,
  (SELECT finished_at FROM routine_runs x WHERE x.routine_id = r.id ORDER BY x.created_at DESC, x.id DESC LIMIT 1) AS last_run_finished_at
  FROM routines r LEFT JOIN projects p ON p.id = r.project_id`

export async function listRoutines(db: D1Database, accountId: string): Promise<RoutineRecord[]> {
  const { results } = await db
    .prepare(`${RECORD_SELECT} WHERE r.account_id = ? AND r.deleted_at IS NULL ORDER BY r.created_at DESC LIMIT 500`)
    .bind(accountId)
    .all<RoutineRecord>()
  return results
}

export function getRoutine(db: D1Database, id: string): Promise<RoutineRecord | null> {
  return db.prepare(`${RECORD_SELECT} WHERE r.id = ? AND r.deleted_at IS NULL`).bind(id).first<RoutineRecord>()
}

export async function insertRoutine(
  db: D1Database,
  input: Omit<RoutineRow, 'id' | 'created_at' | 'updated_at' | 'deleted_at' | 'last_run_at' | 'webhook_id' | 'webhook_secret_hash' | 'webhook_hint'>,
  webhook: WebhookSecret | null,
  now: number
): Promise<string> {
  const id = randomId('rtn')
  await db
    .prepare(
      `INSERT INTO routines (id, account_id, created_by, name, project_id, enabled, trigger_kind, trigger_config, webhook_id,
         webhook_secret_hash, webhook_hint, agent, prompt, machine_size, post_results, max_runtime_ms, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, input.account_id, input.created_by, input.name, input.project_id, input.enabled, input.trigger_kind, input.trigger_config,
      webhook?.id ?? null, webhook?.hash ?? null, webhook?.hint ?? null, input.agent, input.prompt, input.machine_size, input.post_results,
      input.max_runtime_ms, input.next_run_at, now, now)
    .run()
  return id
}

export type RoutinePatch = Partial<
  Pick<RoutineRow, 'name' | 'project_id' | 'enabled' | 'trigger_kind' | 'trigger_config' | 'agent' | 'prompt' | 'machine_size' | 'post_results' | 'max_runtime_ms' | 'next_run_at'>
> & { webhook?: WebhookSecret | null }

export async function updateRoutine(db: D1Database, row: RoutineRow, patch: RoutinePatch, now: number): Promise<void> {
  const { webhook, ...fields } = patch
  const next = { ...row, ...fields }
  const hook = webhook === undefined ? { id: row.webhook_id, hash: row.webhook_secret_hash, hint: row.webhook_hint } : webhook
  await db
    .prepare(
      `UPDATE routines SET name = ?, project_id = ?, enabled = ?, trigger_kind = ?, trigger_config = ?, agent = ?, prompt = ?,
         machine_size = ?, post_results = ?, max_runtime_ms = ?, next_run_at = ?, webhook_id = ?, webhook_secret_hash = ?, webhook_hint = ?,
         updated_at = ?
       WHERE id = ? AND deleted_at IS NULL`
    )
    .bind(next.name, next.project_id, next.enabled, next.trigger_kind, next.trigger_config, next.agent, next.prompt, next.machine_size,
      next.post_results, next.max_runtime_ms, next.next_run_at, hook?.id ?? null, hook?.hash ?? null, hook?.hint ?? null, now, row.id)
    .run()
}

export async function softDeleteRoutine(db: D1Database, id: string, now: number): Promise<void> {
  // The webhook stops resolving at once; the row stays for run history and audit.
  await db
    .prepare('UPDATE routines SET deleted_at = ?, enabled = 0, webhook_id = NULL, webhook_secret_hash = NULL, updated_at = ? WHERE id = ?')
    .bind(now, now, id)
    .run()
}

// Webhook secrets -----------------------------------------------------------------------------

export type WebhookSecret = { id: string; hash: string; hint: string; token: string }

/** `whk_<12 lookup chars>_<32 secret chars>`; only its SHA-256 is stored, `id` finds the row. */
export async function newWebhookSecret(): Promise<WebhookSecret> {
  const id = `whk_${randomToken(12)}`
  const token = `${id}_${randomToken(32)}`
  return { id, token, hash: await sha256Hex(token), hint: token.slice(-4) }
}

export function webhookIdOf(token: string): string | null {
  const match = /^(whk_[A-Za-z0-9]{12})_[A-Za-z0-9]{32}$/.exec(token)
  return match ? match[1]! : null
}

export function getRoutineByWebhookId(db: D1Database, webhookId: string): Promise<RoutineRecord | null> {
  return db.prepare(`${RECORD_SELECT} WHERE r.webhook_id = ? AND r.deleted_at IS NULL`).bind(webhookId).first<RoutineRecord>()
}

// Runs ----------------------------------------------------------------------------------------

/** Inserts a queued run; null when `dedupeKey` already produced one (same slot / delivery). */
export async function insertRun(
  db: D1Database,
  input: { routine: Pick<RoutineRow, 'id' | 'account_id'>; trigger: RunTrigger; detail: Record<string, unknown> | null; dedupeKey: string | null },
  now: number
): Promise<RunRow | null> {
  const id = randomId('run')
  const inserted = await db
    .prepare(
      `INSERT INTO routine_runs (id, routine_id, account_id, trigger_kind, trigger_detail, dedupe_key, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`
    )
    .bind(id, input.routine.id, input.routine.account_id, input.trigger, input.detail ? JSON.stringify(input.detail) : null, input.dedupeKey, now, now)
    .run()
  if ((inserted.meta?.changes ?? 0) === 0) {
    return null
  }
  return getRun(db, id)
}

export function getRun(db: D1Database, id: string): Promise<RunRow | null> {
  return db.prepare('SELECT * FROM routine_runs WHERE id = ?').bind(id).first<RunRow>()
}

export async function listRuns(db: D1Database, routineId: string, options: { before?: number; limit: number }): Promise<RunRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM routine_runs WHERE routine_id = ? AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?')
    .bind(routineId, options.before ?? Number.MAX_SAFE_INTEGER, options.limit)
    .all<RunRow>()
  return results
}

export async function listRunsByStatus(db: D1Database, statuses: readonly RunStatus[], limit = 200): Promise<RunRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM routine_runs WHERE status IN (${statuses.map(() => '?').join(', ')}) ORDER BY created_at LIMIT ?`)
    .bind(...statuses, limit)
    .all<RunRow>()
  return results
}

export async function countRuns(db: D1Database, where: { accountId?: string; routineId?: string }, statuses: readonly RunStatus[]): Promise<number> {
  const clauses = [`status IN (${statuses.map(() => '?').join(', ')})`]
  const binds: string[] = [...statuses]
  if (where.accountId) {
    clauses.push('account_id = ?')
    binds.push(where.accountId)
  }
  if (where.routineId) {
    clauses.push('routine_id = ?')
    binds.push(where.routineId)
  }
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM routine_runs WHERE ${clauses.join(' AND ')}`).bind(...binds).first<{ n: number }>()
  return row?.n ?? 0
}

/**
 * Compare-and-set on status: only the caller that moves a run out of `from` acts on it, so two
 * overlapping ticks never both boot, post or destroy for one run.
 */
export async function claimRun(
  db: D1Database,
  run: Pick<RunRow, 'id'>,
  from: readonly RunStatus[],
  patch: Partial<Pick<RunRow, 'status' | 'sandbox_id' | 'result' | 'error' | 'log_tail' | 'started_at' | 'finished_at'>>,
  now: number
): Promise<RunRow | null> {
  const entries = Object.entries(patch)
  const result = await db
    .prepare(
      `UPDATE routine_runs SET ${[...entries.map(([key]) => `${key} = ?`), 'updated_at = ?'].join(', ')}
       WHERE id = ? AND status IN (${from.map(() => '?').join(', ')})`
    )
    .bind(...entries.map(([, value]) => value ?? null), now, run.id, ...from)
    .run()
  if ((result.meta?.changes ?? 0) === 0) {
    return null
  }
  return getRun(db, run.id)
}

export async function markRoutineRan(db: D1Database, routineId: string, now: number): Promise<void> {
  await db.prepare('UPDATE routines SET last_run_at = ? WHERE id = ?').bind(now, routineId).run()
}
