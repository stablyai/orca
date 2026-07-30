// Explicit, user-initiated worktree recovery. Two disjoint admission shapes:
//
//  1. Provisioning retry — pre_block_state 'selected', a retryable provisioning
//     failure. Restores to 'selected'. The user must then click Start Triage;
//     recovery itself NEVER invokes the provider.
//  2. Legacy recovery — pre_block_state 'planning'/'ready_to_implement' with
//     'worktree_never_provisioned'. Restores that state with prior triage output
//     preserved, so triage is not re-run.
//
// Ambiguous and occupied evidence are admissible under neither shape.
import type Database from '../sqlite/sync-database'
import type { AuditedTaskState } from '../../shared/audited-workflow-types'
import type { WorktreeReasonCode } from '../../shared/audited-worktree-types'
import type { AuditedTaskRow } from './audited-task-row-mapping'
import { getLatestAttempt } from './audited-worktree-attempt-repository'
import { ensureAuditedWorktree } from './audited-worktree-provisioning'
import { restoreTaskAfterWorktreeRecovery } from './audited-worktree-task-writes'

export type WorktreeRecoveryResult =
  | { ok: true; restoredState: AuditedTaskState }
  | { ok: false; reasonCode: WorktreeReasonCode }
  | { ok: false; contended: true }
  | { ok: false; notAdmissible: true }

const LEGACY_PRE_BLOCK_STATES: readonly AuditedTaskState[] = ['planning', 'ready_to_implement']

/**
 * Whether a provisioning retry is safe, judged on DURABLE attempt state rather
 * than the displayed reason code alone.
 *
 * Why the reason code is insufficient: `worktree_unreadable` can arise either
 * before any attempt was claimed (nothing happened — safe to retry) or from
 * post-add drift verification, where `git worktree add` already SUCCEEDED and
 * the attempt is `failed_ambiguous` with its path still guarded. Retrying the
 * latter would claim a fresh attempt against a path that already holds real,
 * unexplained Git state.
 *
 * Rules:
 *  - git_worktree_add_failed    -> only when the latest attempt is failed_no_effect.
 *  - managed_root_unavailable   -> only when no attempt was ever claimed.
 *  - base_commit_unresolvable   -> only when no attempt was ever claimed.
 *  - worktree_unreadable        -> only when no attempt was ever claimed.
 *  - failed_ambiguous (any)     -> never; the path stays guarded and untouched.
 */
function isProvisioningRetrySafe(
  db: Database.Database,
  task: AuditedTaskRow,
  reasonCode: WorktreeReasonCode
): boolean {
  const attempt = getLatestAttempt(db, task.id)

  // Any surviving evidence (live or ambiguous) blocks a fresh claim outright.
  if (
    attempt &&
    (attempt.status === 'failed_ambiguous' ||
      attempt.status === 'claimed' ||
      attempt.status === 'created' ||
      attempt.status === 'verified' ||
      attempt.status === 'finalized')
  ) {
    return false
  }

  // Exhaustive with no `default`, so lint:switch-exhaustiveness fails if a new
  // WorktreeReasonCode is added without an explicit retry-safety decision.
  switch (reasonCode) {
    case 'git_worktree_add_failed':
      // Git provably did nothing, and the path was released.
      return attempt?.status === 'failed_no_effect'
    case 'managed_root_unavailable':
    case 'base_commit_unresolvable':
    case 'worktree_unreadable':
      // Only retryable when they happened BEFORE a claim, i.e. no attempt row
      // exists (an 'abandoned' row also proves all evidence was absent, so it is
      // equally safe). worktree_unreadable raised by POST-ADD verification is
      // excluded by the failed_ambiguous check above.
      return attempt === null || attempt.status === 'abandoned'
    // Never retryable: each either left Git state behind, or describes a
    // configuration/identity problem a retry cannot resolve.
    case 'branch_already_exists':
    case 'branch_tip_moved_from_base_commit':
    case 'head_branch_mismatch':
    case 'head_moved_from_base_commit':
    case 'head_not_symbolic':
    case 'managed_root_escapes_workspace':
    case 'managed_root_inside_source_repo':
    case 'provision_evidence_ambiguous':
    case 'repository_identity_mismatch':
    case 'source_repo_inside_managed_root':
    case 'unsupported_host':
    case 'worktree_missing':
    case 'worktree_never_provisioned':
    case 'worktree_path_mismatch':
    case 'worktree_path_occupied':
    case 'worktree_path_outside_managed_root':
      return false
  }
}

/**
 * Whether `provisionWorktree` may act on this blocked task. Deliberately
 * strict — a mismatched pre_block_state, a non-retryable reason, or surviving
 * attempt evidence is refused rather than coerced into one of the two shapes.
 */
export function resolveRecoveryAdmission(
  db: Database.Database,
  task: AuditedTaskRow
): { admissible: true; restoreTo: AuditedTaskState } | { admissible: false } {
  if (task.state !== 'blocked' || task.worktreeReasonCode === null) {
    return { admissible: false }
  }

  if (
    task.preBlockState === 'selected' &&
    isProvisioningRetrySafe(db, task, task.worktreeReasonCode)
  ) {
    return { admissible: true, restoreTo: 'selected' }
  }

  if (
    task.preBlockState !== null &&
    LEGACY_PRE_BLOCK_STATES.includes(task.preBlockState) &&
    task.worktreeReasonCode === 'worktree_never_provisioned' &&
    // A legacy task must genuinely have no attempt evidence.
    getLatestAttempt(db, task.id) === null
  ) {
    return { admissible: true, restoreTo: task.preBlockState }
  }

  return { admissible: false }
}

export type RecoveryContext = {
  db: Database.Database
  task: AuditedTaskRow
  workspaceRoot: string
  nowMs: () => number
}

/**
 * Provisions a worktree for an admissible blocked task and restores its prior
 * state. Never calls the triage provider and never performs the
 * `selected -> triaging` CAS — that stays an explicit, separate user action.
 */
export async function recoverAuditedWorktree(
  context: RecoveryContext
): Promise<WorktreeRecoveryResult> {
  const admission = resolveRecoveryAdmission(context.db, context.task)
  if (!admission.admissible) {
    return { ok: false, notAdmissible: true }
  }

  const provisioned = await ensureAuditedWorktree({
    db: context.db,
    task: context.task,
    workspaceRoot: context.workspaceRoot,
    nowMs: context.nowMs
  })

  if (!provisioned.ok) {
    if ('contended' in provisioned) {
      return { ok: false, contended: true }
    }
    return { ok: false, reasonCode: provisioned.reasonCode }
  }

  const restored = restoreTaskAfterWorktreeRecovery(
    context.db,
    context.task.id,
    admission.restoreTo,
    context.nowMs()
  )
  if (!restored.ok) {
    return { ok: false, contended: true }
  }

  return { ok: true, restoredState: admission.restoreTo }
}
