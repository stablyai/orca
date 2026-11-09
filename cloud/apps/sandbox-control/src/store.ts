// D1 access for sandbox rows. Every transition is a compare-and-set on `generation`, so two
// concurrent lifecycle calls for one sandbox cannot both act on the provider.
import type { MachineSize } from './entitlements'

export type SandboxStatus =
  | 'creating'
  | 'running'
  | 'suspending'
  | 'suspended'
  | 'resuming'
  | 'destroying'
  | 'destroyed'
  | 'failed'
  /** Stopped with the snapshot kept for a TTL; unarchive resumes it, the cron destroys it after the TTL. */
  | 'archived'

export type SandboxRow = {
  id: string
  account_id: string
  user_id: string
  workspace_id: string
  provider: string
  provider_name: string
  status: SandboxStatus
  machine_size: MachineSize
  region: string
  generation: number
  session_id: string | null
  session_started_at: number | null
  session_deadline_at: number | null
  lease_expires_at: number | null
  usage_settled_at: number | null
  last_error: string | null
  created_at: number
  updated_at: number
  destroyed_at: number | null
  repo_url: string | null
  github_token_expires_at: number | null
  /** Comma list of `SECRET@host` model credentials the egress proxy swaps in this session. */
  egress_secret_hosts: string | null
  /** Comma list of custom model-provider hosts added to this session's egress allowlist. */
  egress_allow_hosts: string | null
  retention_warned_at: number | null
  /** Environment build this sandbox first booted from (null: the golden image). Never changes. */
  environment_id: string | null
  environment_build_id: string | null
  source_snapshot_id: string | null
  /** orcad's public wss endpoint for the current session. */
  orcad_endpoint: string | null
  /** When orcad last became ready (wake callers report it as `readyAt`). */
  ready_at: number | null
  archived_at: number | null
  archive_expires_at: number | null
  /** Registry (0006). `user_id` is the current owner (reassignable); `created_by` never changes. */
  created_by: string | null
  /** Display name (0020's `name`; the API calls it `title`). */
  name: string | null
  repo_branch: string | null
  visibility: WorkspaceVisibility
  section: string | null
  /** 0020: machine-made rows (routine runs) stay out of default lists. */
  hidden?: number
  last_activity_at: number | null
  last_activity_by: string | null
  token_usd_micros: number | null
}

export type WorkspaceVisibility = 'private' | 'team'

export type SessionFields = Pick<
  SandboxRow,
  'session_id' | 'session_started_at' | 'session_deadline_at' | 'lease_expires_at' | 'usage_settled_at'
>

export const NO_SESSION: SessionFields & Pick<SandboxRow, 'orcad_endpoint'> = {
  orcad_endpoint: null,
  session_id: null,
  session_started_at: null,
  session_deadline_at: null,
  lease_expires_at: null,
  usage_settled_at: null
}

/** Counted against the plan's concurrency limit. */
export const ACTIVE_STATUSES: readonly SandboxStatus[] = ['creating', 'running', 'resuming', 'suspending']

export async function insertSandbox(
  db: D1Database,
  row: Pick<
    SandboxRow,
    'id' | 'account_id' | 'user_id' | 'workspace_id' | 'provider' | 'provider_name' | 'machine_size' | 'region' | 'repo_url'
  > &
    Partial<Pick<SandboxRow, 'environment_id' | 'environment_build_id' | 'source_snapshot_id' | 'name' | 'repo_branch' | 'visibility' | 'section'>>,
  now: number
): Promise<SandboxRow> {
  await db
    .prepare(
      `INSERT INTO sandboxes (id, account_id, user_id, workspace_id, provider, provider_name, status,
         machine_size, region, generation, created_at, updated_at, repo_url, environment_id, environment_build_id,
         source_snapshot_id, created_by, name, repo_branch, visibility, section, last_activity_at, last_activity_by)
       VALUES (?, ?, ?, ?, ?, ?, 'creating', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(row.id, row.account_id, row.user_id, row.workspace_id, row.provider, row.provider_name,
      row.machine_size, row.region, now, now, row.repo_url, row.environment_id ?? null,
      row.environment_build_id ?? null, row.source_snapshot_id ?? null, row.user_id, row.name ?? null,
      row.repo_branch ?? null, row.visibility ?? 'private', row.section ?? null, now, row.user_id)
    .run()
  const inserted = await getSandbox(db, row.id)
  if (!inserted) {
    throw new Error('sandbox insert lost')
  }
  return inserted
}

export function getSandbox(db: D1Database, id: string): Promise<SandboxRow | null> {
  return db.prepare('SELECT * FROM sandboxes WHERE id = ?').bind(id).first<SandboxRow>()
}

export function getSandboxByProviderName(db: D1Database, name: string): Promise<SandboxRow | null> {
  return db.prepare('SELECT * FROM sandboxes WHERE provider_name = ?').bind(name).first<SandboxRow>()
}

/** A failed attempt that is still being cleaned up stops blocking its workspace (unique live index). */
export async function detachFromWorkspace(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(`UPDATE sandboxes SET workspace_id = workspace_id || '#abandoned:' || id WHERE id = ? AND status <> 'destroyed'`)
    .bind(id)
    .run()
}

export function liveSandboxForWorkspace(
  db: D1Database,
  accountId: string,
  workspaceId: string
): Promise<SandboxRow | null> {
  return db
    .prepare(`SELECT * FROM sandboxes WHERE account_id = ? AND workspace_id = ? AND status <> 'destroyed'`)
    .bind(accountId, workspaceId)
    .first<SandboxRow>()
}

export async function listAccountSandboxes(db: D1Database, accountId: string): Promise<SandboxRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM sandboxes WHERE account_id = ? AND status <> 'destroyed' ORDER BY created_at`)
    .bind(accountId)
    .all<SandboxRow>()
  return results
}

export async function countActiveSandboxes(db: D1Database, accountId: string): Promise<number> {
  const placeholders = ACTIVE_STATUSES.map(() => '?').join(', ')
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM sandboxes WHERE account_id = ? AND status IN (${placeholders})`)
    .bind(accountId, ...ACTIVE_STATUSES)
    .first<{ n: number }>()
  return row?.n ?? 0
}

export async function countActiveSandboxesForUser(db: D1Database, accountId: string, userId: string): Promise<number> {
  const placeholders = ACTIVE_STATUSES.map(() => '?').join(', ')
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM sandboxes WHERE account_id = ? AND user_id = ? AND status IN (${placeholders})`)
    .bind(accountId, userId, ...ACTIVE_STATUSES)
    .first<{ n: number }>()
  return row?.n ?? 0
}

export async function listByStatus(db: D1Database, statuses: readonly SandboxStatus[]): Promise<SandboxRow[]> {
  const placeholders = statuses.map(() => '?').join(', ')
  const { results } = await db
    .prepare(`SELECT * FROM sandboxes WHERE status IN (${placeholders}) ORDER BY updated_at LIMIT 200`)
    .bind(...statuses)
    .all<SandboxRow>()
  return results
}

type Patch = Partial<Omit<SandboxRow, 'id' | 'account_id' | 'generation' | 'created_at'>>
const PATCHABLE = new Set<string>([
  'status', 'session_id', 'session_started_at', 'session_deadline_at', 'lease_expires_at',
  'usage_settled_at', 'last_error', 'destroyed_at', 'github_token_expires_at',
  'egress_secret_hosts', 'egress_allow_hosts', 'repo_url', 'retention_warned_at', 'orcad_endpoint', 'ready_at',
  'archived_at', 'archive_expires_at'
])

export type RegistryPatch = Partial<
  Pick<SandboxRow, 'name' | 'repo_branch' | 'visibility' | 'section' | 'archived_at' | 'user_id' | 'token_usd_micros'>
>
const REGISTRY_PATCHABLE = new Set<string>(['name', 'repo_branch', 'visibility', 'section', 'archived_at', 'user_id', 'token_usd_micros'])

/**
 * Registry metadata (title, visibility, owner, ...). Deliberately not a `transition`: it never
 * bumps `generation`, so renaming or a presence heartbeat cannot fail a concurrent resume's CAS.
 */
// `updated_at` is the lifecycle clock (cron sweeps read it), so metadata edits leave it alone.
export async function updateRegistry(db: D1Database, id: string, patch: RegistryPatch): Promise<SandboxRow | null> {
  const entries = Object.entries(patch).filter(([key]) => REGISTRY_PATCHABLE.has(key))
  if (entries.length > 0) {
    await db
      .prepare(`UPDATE sandboxes SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ? AND status <> 'destroyed'`)
      .bind(...entries.map(([, value]) => value ?? null), id)
      .run()
  }
  return getSandbox(db, id)
}

/** Last activity (open, message, presence) — coarse, at most one write a minute per workspace. */
export async function touchActivity(db: D1Database, id: string, userId: string, now: number): Promise<void> {
  await db
    .prepare('UPDATE sandboxes SET last_activity_at = ?, last_activity_by = ? WHERE id = ? AND (last_activity_at IS NULL OR last_activity_at < ?)')
    .bind(now, userId, id, now - 60_000)
    .run()
}

/** Applies `patch` only if nobody moved the row since `expected` was read; null on a lost race. */
export async function transition(
  db: D1Database,
  expected: SandboxRow,
  patch: Patch,
  now: number
): Promise<SandboxRow | null> {
  const entries = Object.entries(patch).filter(([key]) => PATCHABLE.has(key))
  const assignments = entries.map(([key]) => `${key} = ?`).join(', ')
  const result = await db
    .prepare(
      `UPDATE sandboxes SET ${assignments}${assignments ? ', ' : ''}generation = generation + 1, updated_at = ?
       WHERE id = ? AND generation = ?`
    )
    .bind(...entries.map(([, value]) => value ?? null), now, expected.id, expected.generation)
    .run()
  return result.meta.changes === 1 ? getSandbox(db, expected.id) : null
}

export async function recordSnapshots(db: D1Database, sandboxId: string, ids: readonly string[], now: number) {
  if (ids.length === 0) {
    return
  }
  await db.batch(
    ids.map((id) =>
      db
        .prepare('INSERT OR IGNORE INTO sandbox_snapshots (snapshot_id, sandbox_id, recorded_at) VALUES (?, ?, ?)')
        .bind(id, sandboxId, now)
    )
  )
}

export async function markSnapshotsDeleted(db: D1Database, sandboxId: string, now: number) {
  await db
    .prepare('UPDATE sandbox_snapshots SET deleted_at = ? WHERE sandbox_id = ? AND deleted_at IS NULL')
    .bind(now, sandboxId)
    .run()
}

export async function recordedSnapshotIds(db: D1Database, sandboxId: string): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT snapshot_id FROM sandbox_snapshots WHERE sandbox_id = ?')
    .bind(sandboxId)
    .all<{ snapshot_id: string }>()
  return results.map((row) => row.snapshot_id)
}

/** Usage so far for one sandbox: settled segments plus the open one (ms). */
export async function sandboxUsageMs(db: D1Database, row: SandboxRow, now: number): Promise<number> {
  const settled = await db
    .prepare('SELECT COALESCE(SUM(ended_at - started_at), 0) AS ms FROM usage_outbox WHERE sandbox_id = ?')
    .bind(row.id)
    .first<{ ms: number }>()
  const open = row.status === 'running' && row.usage_settled_at !== null ? Math.max(0, now - row.usage_settled_at) : 0
  return (settled?.ms ?? 0) + open
}
