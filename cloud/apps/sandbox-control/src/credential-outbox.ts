// Outbox (credential_pushes): a credential change is recorded where it happens, pushed right
// away when the caller can, and retried by the tick until every running sandbox that carries the credential
// has the policy for it. A change landing mid-push leaves the row pending (compare-and-swap on changed_at),
// so it is pushed again. The push itself is the lifecycle's whole-policy rewrite (injected).
import type { CredentialAgent } from './agent-credential-names'

export type CredentialChange =
  | { kind: 'account'; agent: CredentialAgent; userId: string }
  | { kind: 'github_user'; accountId: string; userId: string }

const PUSH_LEASE_MS = 120_000
const PUSH_BATCH = 20

function keyOf(change: CredentialChange): { kind: string; subject: string } {
  return change.kind === 'account'
    ? { kind: `account:${change.agent}`, subject: change.userId }
    : { kind: 'github_user', subject: `${change.accountId}#${change.userId}` }
}

function changeOf(kind: string, subject: string): CredentialChange | null {
  if (kind === 'account:claude' || kind === 'account:codex') {
    return { kind: 'account', agent: kind.slice('account:'.length) as CredentialAgent, userId: subject }
  }
  const at = subject.indexOf('#')
  return kind === 'github_user' && at > 0 ? { kind: 'github_user', accountId: subject.slice(0, at), userId: subject.slice(at + 1) } : null
}

/** Records that a credential changed: its sandboxes need a policy rewrite. Never throws (best effort, retried by the next change). */
export async function markCredentialChanged(db: D1Database, change: CredentialChange, now: number): Promise<void> {
  const { kind, subject } = keyOf(change)
  await db
    .prepare(
      `INSERT INTO credential_pushes (kind, subject, changed_at, pushed_at, attempts) VALUES (?, ?, ?, NULL, 0)
       ON CONFLICT (kind, subject) DO UPDATE SET changed_at = MAX(excluded.changed_at, credential_pushes.changed_at + 1),
         attempts = 0, next_attempt_at = NULL`
    )
    .bind(kind, subject, now)
    .run()
    .catch((error: unknown) => log('credential_push_mark_failed', { kind, error: String(error).slice(0, 120) }))
}

export type PushDeps = {
  db: D1Database
  now: () => number
  /** Running sandbox ids whose policy carries this credential. */
  targets: (change: CredentialChange) => Promise<string[]>
  /** Rewrites one running sandbox's whole policy (and session env) from current state. False: not running any more. */
  push: (sandboxId: string, change: CredentialChange) => Promise<boolean>
}

export type PushSummary = { pending: number; pushed: number; sandboxes: number; failed: number }

/** Pushes one recorded change to every affected sandbox, under the row's lease. */
async function pushOne(deps: PushDeps, kind: string, subject: string, counted?: { sandboxes: number }): Promise<'pushed' | 'failed' | 'skipped'> {
  const owner = crypto.randomUUID()
  const start = deps.now()
  const claimed = await deps.db
    .prepare(
      `UPDATE credential_pushes SET lease_owner = ?, lease_until = ?
       WHERE kind = ? AND subject = ? AND (lease_until IS NULL OR lease_until <= ?) AND (pushed_at IS NULL OR pushed_at < changed_at)`
    )
    .bind(owner, start + PUSH_LEASE_MS, kind, subject, start)
    .run()
  if (claimed.meta.changes !== 1) {
    return 'skipped'
  }
  const row = await deps.db
    .prepare('SELECT changed_at, attempts FROM credential_pushes WHERE kind = ? AND subject = ?')
    .bind(kind, subject)
    .first<{ changed_at: number; attempts: number }>()
  const change = changeOf(kind, subject)
  if (!row || !change) {
    await deps.db.prepare('DELETE FROM credential_pushes WHERE kind = ? AND subject = ? AND lease_owner = ?').bind(kind, subject, owner).run()
    return 'skipped'
  }
  let failed = 0
  let count = 0
  for (const sandboxId of await deps.targets(change)) {
    count++
    if (counted) {
      counted.sandboxes++
    }
    const ok = await deps.push(sandboxId, change).then(
      () => true,
      (error: unknown) => {
        log('credential_push_sandbox_failed', { kind, sandboxId, error: String(error).slice(0, 120) })
        return false
      }
    )
    if (!ok) {
      failed++
    }
  }
  if (failed > 0) {
    const attempts = row.attempts + 1
    await deps.db
      .prepare(
        `UPDATE credential_pushes SET lease_owner = NULL, lease_until = NULL, attempts = ?, next_attempt_at = ?
         WHERE kind = ? AND subject = ? AND lease_owner = ?`
      )
      .bind(attempts, deps.now() + Math.min(10, attempts) * 60_000, kind, subject, owner)
      .run()
    log('credential_push_failed', { kind, sandboxes: count, failed, attempts })
    return 'failed'
  }
  // Pushed up to the change this push saw; a newer change keeps the row pending.
  await deps.db
    .prepare(
      `UPDATE credential_pushes SET lease_owner = NULL, lease_until = NULL, pushed_at = ?, attempts = 0, next_attempt_at = NULL
       WHERE kind = ? AND subject = ? AND lease_owner = ?`
    )
    .bind(row.changed_at, kind, subject, owner)
    .run()
  if (count > 0) {
    log('credential_pushed', { kind, sandboxes: count, latencyMs: deps.now() - row.changed_at })
  }
  return 'pushed'
}

/** Pushes one change now (the caller just made it); the tick retries whatever this leaves pending. */
export async function pushCredentialChange(deps: PushDeps, change: CredentialChange): Promise<void> {
  const { kind, subject } = keyOf(change)
  await markCredentialChanged(deps.db, change, deps.now())
  await pushOne(deps, kind, subject).catch((error: unknown) => log('credential_push_error', { kind, error: String(error).slice(0, 120) }))
}

/** Tick: every pending change, oldest first, each under its own lease (single-flight across isolates and ticks). */
export async function pushPendingCredentialChanges(deps: PushDeps): Promise<PushSummary> {
  const now = deps.now()
  const { results } = await deps.db
    .prepare(
      `SELECT kind, subject FROM credential_pushes
       WHERE (pushed_at IS NULL OR pushed_at < changed_at) AND (lease_until IS NULL OR lease_until <= ?)
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY changed_at LIMIT ?`
    )
    .bind(now, now, PUSH_BATCH)
    .all<{ kind: string; subject: string }>()
  const summary: PushSummary = { pending: results.length, pushed: 0, sandboxes: 0, failed: 0 }
  for (const { kind, subject } of results) {
    const outcome = await pushOne(deps, kind, subject, summary).catch(() => 'failed' as const)
    if (outcome === 'pushed') {
      summary.pushed++
    } else if (outcome === 'failed') {
      summary.failed++
    }
  }
  // Pushed rows older than a day carry nothing: the next change re-creates them.
  await deps.db
    .prepare('DELETE FROM credential_pushes WHERE pushed_at IS NOT NULL AND pushed_at >= changed_at AND changed_at < ?')
    .bind(now - 24 * 60 * 60_000)
    .run()
    .catch(() => undefined)
  return summary
}

/** Default targets: the sandboxes whose policy can hold this credential. */
export async function credentialPushTargets(db: D1Database, change: CredentialChange): Promise<string[]> {
  if (change.kind === 'github_user') {
    return runningSandboxesForMember(db, change.accountId, change.userId)
  }
  // Account sign-ins apply only on the owner's own workspaces (never shared).
  const { results } = await db
    .prepare(`SELECT id FROM sandboxes WHERE user_id = ? AND status = 'running' LIMIT 200`)
    .bind(change.userId)
    .all<{ id: string }>()
  return results.map((r) => r.id)
}

/** Running workspaces whose policy can carry this member's GitHub identity (connectedMembers' rule, inverted). */
export async function runningSandboxesForMember(db: D1Database, accountId: string, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT s.id FROM sandboxes s WHERE s.account_id = ? AND s.status = 'running' AND s.repo_url IS NOT NULL
         AND ((s.user_id = ? AND s.ownership_transferred_at IS NULL)
           OR EXISTS (SELECT 1 FROM workspace_grants g WHERE g.sandbox_id = s.id AND g.user_id = ? AND g.status = 'active'))
       LIMIT 200`
    )
    .bind(accountId, userId, userId)
    .all<{ id: string }>()
  return results.map((r) => r.id)
}

function log(event: string, fields: Record<string, unknown>) {
  // Kinds, sandbox ids and counts only; never a credential.
  console.log(JSON.stringify({ event, ...fields }))
}
