// Persistence for land attempts (Phase 10): CAS admission and the two bindings
// that must BOTH hold before a single byte of the user's source repository moves.
//
// The invariant: an `authorized` attempt exists ONLY while a land is in flight OR
// its outcome is still unknown, bound to the Phase 8 commit attempt that produced
// the exact committed_sha AND to the Phase 9 publish attempt that proved that sha
// present on the remote. Because admission requires no live attempt, an unknown
// outcome structurally blocks a second ref update until an evidence read
// classifies it.
//
// EVERY WRITE HERE IS PURE SQLITE. Git and filesystem work happen strictly
// between these calls, never inside their transactions.
import type Database from '../sqlite/sync-database'
import type { LandAttemptStatus, LandingAdvisoryCode } from '../../shared/audited-landing-types'
import type { LandingReasonCode } from '../../shared/audited-workflow-types'
import { hasLiveCodeAuditRun } from './audited-candidate-repository'
import { hasLiveExecutionRun } from './audited-execution-run-repository'
import { resolvePublishableCommitAttempt } from './audited-publish-attempt-repository'

export type LandAttemptRow = {
  id: string
  taskId: string
  commitAttemptId: string
  publishAttemptId: string
  intendedSha: string
  intendedBranch: string
  intendedBaseSha: string
  sourceRepoPath: string
  sourceRepoCommonDir: string
  status: LandAttemptStatus
  reasonCode: LandingReasonCode | null
  refUpdateStarted: boolean
  refUpdateCompleted: boolean
  worktreeUpdateStarted: boolean
  worktreeUpdateCompleted: boolean
  landedSha: string | null
  landingAdvisory: LandingAdvisoryCode | null
  authorizedAt: number
  finalizedAt: number | null
}

export function sqliteRowToLandAttempt(row: Record<string, unknown>): LandAttemptRow {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    commitAttemptId: row.commit_attempt_id as string,
    publishAttemptId: row.publish_attempt_id as string,
    intendedSha: row.intended_sha as string,
    intendedBranch: row.intended_branch as string,
    intendedBaseSha: row.intended_base_sha as string,
    sourceRepoPath: row.source_repo_path as string,
    sourceRepoCommonDir: row.source_repo_common_dir as string,
    status: row.status as LandAttemptStatus,
    reasonCode: (row.reason_code as LandingReasonCode | null) ?? null,
    refUpdateStarted: Boolean(row.ref_update_started),
    refUpdateCompleted: Boolean(row.ref_update_completed),
    worktreeUpdateStarted: Boolean(row.worktree_update_started),
    worktreeUpdateCompleted: Boolean(row.worktree_update_completed),
    landedSha: (row.landed_sha as string | null) ?? null,
    landingAdvisory: (row.landing_advisory as LandingAdvisoryCode | null) ?? null,
    authorizedAt: row.authorized_at_ms as number,
    finalizedAt: (row.finalized_at_ms as number | null) ?? null
  }
}

export function generateLandAttemptId(): string {
  const hex = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  return `latt_${hex}`
}

export function getLandAttempt(db: Database.Database, id: string): LandAttemptRow | null {
  const row = db.prepare(`SELECT * FROM audited_land_attempts WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined
  return row ? sqliteRowToLandAttempt(row) : null
}

export function getLatestLandAttempt(db: Database.Database, taskId: string): LandAttemptRow | null {
  const row = db
    .prepare(
      `SELECT * FROM audited_land_attempts WHERE task_id = ?
        ORDER BY authorized_at_ms DESC, rowid DESC LIMIT 1`
    )
    .get(taskId) as Record<string, unknown> | undefined
  return row ? sqliteRowToLandAttempt(row) : null
}

export function getAuthorizedLandAttempts(db: Database.Database): { id: string; taskId: string }[] {
  return (
    db
      .prepare(`SELECT id, task_id FROM audited_land_attempts WHERE status = 'authorized'`)
      .all() as { id: string; task_id: string }[]
  ).map((row) => ({ id: row.id, taskId: row.task_id }))
}

/** True while a publish outcome is still unknown — landing must wait. */
export function hasLivePublishAttempt(db: Database.Database, taskId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM audited_publish_attempts WHERE task_id = ? AND status = 'authorized' LIMIT 1`
    )
    .get(taskId)
  return row !== undefined
}

export type PublicationBindingResult =
  | { ok: true; publishAttemptId: string }
  | { ok: false; reasonCode: LandingReasonCode }

/**
 * THE PHASE 9 PUBLICATION GATE, resolved by ONE query.
 *
 * A local Phase 8 commit without a CONFIRMED publication must not land: landing
 * writes the user's own working tree, and doing so for work no remote has ever
 * seen would make the source repo depend on a commit that exists only here.
 *
 * ALL of the following, not any subset:
 *   1. status === 'completed'
 *   2. intended_sha === committedSha  (it published THIS commit, not an earlier one)
 *   3. pushed_sha   === committedSha  (ls-remote CONFIRMED the remote carries it)
 *   4. pushed_sha   === intended_sha  (no cross-wired row)
 *
 * Condition 3 is load-bearing. pushed_sha is written ONLY after P3's ls-remote
 * confirms the remote ref equals intended_sha — a push exit code proves nothing
 * in either direction. Testing status alone would be weaker; testing the task's
 * denormalized published_sha would be weaker still, since that column can lag.
 *
 * LATEST-ONLY, mirroring the Phase 8 binding: an older completed attempt can
 * coexist with a newer failed one, and landing on the stale row would assert a
 * publication the lane's current state no longer supports.
 *
 * DELIBERATELY IGNORES publish_advisory: every review-request outcome is
 * advisory-only, and gating on one would refuse to land genuinely published work.
 *
 * The projection calls this too, so what the UI offers and what admission permits
 * cannot diverge.
 */
export function resolveLandablePublishAttempt(
  db: Database.Database,
  taskId: string,
  committedSha: string | null
): PublicationBindingResult {
  if (!committedSha) {
    return { ok: false, reasonCode: 'committed_candidate_invalid' }
  }
  const row = db
    .prepare(
      `SELECT id, status, intended_sha, pushed_sha FROM audited_publish_attempts
        WHERE task_id = ? ORDER BY authorized_at_ms DESC, rowid DESC LIMIT 1`
    )
    .get(taskId) as
    | { id: string; status: string; intended_sha: string; pushed_sha: string | null }
    | undefined

  if (!row) {
    return { ok: false, reasonCode: 'task_not_published' }
  }
  if (row.status === 'authorized') {
    // The outcome is unknown. Recheck must classify it before landing can be
    // considered at all — this is NOT a failure of publication, just an unknown.
    return { ok: false, reasonCode: 'publish_in_progress' }
  }
  if (row.status !== 'completed') {
    return { ok: false, reasonCode: 'task_not_published' }
  }
  if (row.intended_sha !== committedSha) {
    return { ok: false, reasonCode: 'publish_sha_mismatch' }
  }
  if (row.pushed_sha === null || row.pushed_sha !== committedSha) {
    return { ok: false, reasonCode: 'publish_not_confirmed' }
  }
  if (row.pushed_sha !== row.intended_sha) {
    return { ok: false, reasonCode: 'publish_not_confirmed' }
  }
  return { ok: true, publishAttemptId: row.id }
}

export type AuthorizeLandArgs = {
  taskId: string
  commitAttemptId: string
  publishAttemptId: string
  intendedSha: string
  intendedBranch: string
  intendedBaseSha: string
  sourceRepoPath: string
  sourceRepoCommonDir: string
  /** The verified AUDITED worktree identity this attempt depends on; re-checked here. */
  expectedWorktreePath: string
  expectedWorktreeVerifiedAt: number
}

export type AuthorizeLandResult =
  | { ok: true; attemptId: string; sourceRepoPath: string }
  | { ok: false; reasonCode: LandingReasonCode }

/**
 * CAS-PROTECTED ADMISSION.
 *
 * startLand necessarily verifies the worktree and reads the source repo BEFORE it
 * can open a write transaction, and the task can change in that window.
 * Everything is re-verified HERE, inside BEGIN IMMEDIATE, immediately before the
 * insert:
 *
 *   1. no Claude execution, no code audit, and no publish is live;
 *   2. the task is still `committed` with the same committed_sha;
 *   3. the Phase 8 binding still holds (completed attempt, exact sha, same id);
 *   4. the Phase 9 publication binding still holds (completed, confirmed, same id);
 *   5. the host is still local;
 *   6. the audited worktree identity still matches.
 *
 * Any failure returns a closed code and inserts NOTHING, so no attempt exists and
 * the caller never runs a Git mutation.
 *
 * On success the task moves `committed` -> `landing` in the SAME transaction, so a
 * reader never sees an authorized attempt against a task that still looks idle.
 */
export function authorizeLandAttempt(
  db: Database.Database,
  args: AuthorizeLandArgs,
  nowMs: number
): AuthorizeLandResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    if (hasLiveExecutionRun(db, args.taskId)) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'execution_in_progress' }
    }
    if (hasLiveCodeAuditRun(db, args.taskId)) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'code_audit_in_progress' }
    }
    if (hasLivePublishAttempt(db, args.taskId)) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'publish_in_progress' }
    }

    const task = db
      .prepare(
        `SELECT state, committed_sha, branch_name, base_commit, source_repo_path,
                source_repo_common_dir, worktree_path, worktree_verified_at_ms,
                worktree_reason_code, host_id, wsl_distro
           FROM audited_tasks WHERE id = ?`
      )
      .get(args.taskId) as
      | {
          state: string
          committed_sha: string | null
          branch_name: string | null
          base_commit: string
          source_repo_path: string
          source_repo_common_dir: string | null
          worktree_path: string | null
          worktree_verified_at_ms: number | null
          worktree_reason_code: string | null
          host_id: string
          wsl_distro: string | null
        }
      | undefined
    if (!task) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'illegal_transition' }
    }
    if (task.state !== 'committed') {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'task_not_committed' }
    }
    if (!task.committed_sha) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'committed_candidate_invalid' }
    }
    if (task.committed_sha !== args.intendedSha) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'commit_attempt_not_completed' }
    }
    if (task.wsl_distro !== null || task.host_id !== 'local') {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'landing_host_unsupported' }
    }

    // THE PHASE 8 BINDING, re-resolved inside the transaction.
    const commitBinding = resolvePublishableCommitAttempt(db, args.taskId, task.committed_sha)
    if (!commitBinding || commitBinding.attemptId !== args.commitAttemptId) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'commit_attempt_not_completed' }
    }

    // THE PHASE 9 PUBLICATION BINDING, re-resolved inside the transaction. A
    // DIFFERENT completed attempt satisfying the same sha is still a change of
    // the world we admitted against, so the id is compared too.
    const publishBinding = resolveLandablePublishAttempt(db, args.taskId, task.committed_sha)
    if (!publishBinding.ok) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: publishBinding.reasonCode }
    }
    if (publishBinding.publishAttemptId !== args.publishAttemptId) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'publish_sha_mismatch' }
    }

    if (
      task.worktree_path !== args.expectedWorktreePath ||
      task.worktree_verified_at_ms !== args.expectedWorktreeVerifiedAt ||
      task.worktree_reason_code !== null
    ) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'worktree_identity_changed' }
    }
    if (task.branch_name !== args.intendedBranch) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'worktree_identity_changed' }
    }
    if (task.base_commit !== args.intendedBaseSha) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'worktree_identity_changed' }
    }
    // The source repo identity must be the one L0 verified, not merely the one
    // the caller captured before awaiting.
    if (
      task.source_repo_path !== args.sourceRepoPath ||
      task.source_repo_common_dir !== args.sourceRepoCommonDir
    ) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'source_repo_mismatch' }
    }

    const attemptId = generateLandAttemptId()
    try {
      db.prepare(
        `INSERT INTO audited_land_attempts
           (id, task_id, commit_attempt_id, publish_attempt_id, intended_sha, intended_branch,
            intended_base_sha, source_repo_path, source_repo_common_dir, status, authorized_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'authorized', ?)`
      ).run(
        attemptId,
        args.taskId,
        args.commitAttemptId,
        args.publishAttemptId,
        args.intendedSha,
        args.intendedBranch,
        args.intendedBaseSha,
        args.sourceRepoPath,
        args.sourceRepoCommonDir,
        nowMs
      )
    } catch {
      // The partial unique index rejected a second live attempt. This is ALSO
      // the guard that stops a retry while an outcome is unknown.
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    const moved = db
      .prepare(
        `UPDATE audited_tasks
            SET state = 'landing', land_attempt_status = 'authorized',
                landing_reason_code = NULL, landing_advisory = NULL, updated_at_ms = ?
          WHERE id = ? AND state = 'committed'`
      )
      .run(nowMs, args.taskId)
    if (moved.changes !== 1) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    db.prepare(
      `INSERT INTO audited_transitions
         (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
       VALUES (?, 'committed', 'landing', 'human', 'land_authorized', NULL, NULL, ?)`
    ).run(args.taskId, nowMs)

    db.exec('COMMIT')
    // The cwd the caller must use: read INSIDE this transaction and proven to
    // match the verified identity. A captured path is never authoritative.
    return { ok: true, attemptId, sourceRepoPath: task.source_repo_path }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

// Per-phase evidence writes and finalization live in their own module so this
// file stays within its line budget; re-exported so call sites import one name.
export * from './audited-land-attempt-finalize'
