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
  /** Comma list of model API hosts whose key the egress proxy swaps in this session. */
  egress_secret_hosts: string | null
  retention_warned_at: number | null
}

export type SessionFields = Pick<
  SandboxRow,
  'session_id' | 'session_started_at' | 'session_deadline_at' | 'lease_expires_at' | 'usage_settled_at'
>

export const NO_SESSION: SessionFields = {
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
  >,
  now: number
): Promise<SandboxRow> {
  await db
    .prepare(
      `INSERT INTO sandboxes (id, account_id, user_id, workspace_id, provider, provider_name, status,
         machine_size, region, generation, created_at, updated_at, repo_url)
       VALUES (?, ?, ?, ?, ?, ?, 'creating', ?, ?, 0, ?, ?, ?)`
    )
    .bind(row.id, row.account_id, row.user_id, row.workspace_id, row.provider, row.provider_name,
      row.machine_size, row.region, now, now, row.repo_url)
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
  'egress_secret_hosts', 'repo_url', 'retention_warned_at'
])

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
