// Startup reconciliation for audited worktrees.
//
// Performs NO agent invocation, NO network access, and NO Git mutation — every
// Git command it issues is read-only and optional-lock suppressed, so it cannot
// rewrite .git/index. Idempotent and CAS-safe: a second pass finds nothing left
// to do.
import type Database from '../sqlite/sync-database'
import type { AuditedTaskState, ReconcileClass } from '../../shared/audited-workflow-types'
import type { WorktreeReasonCode } from '../../shared/audited-worktree-types'
import {
  mapWorktreeReasonToReconcileClass,
  mapWorktreeReasonToReconcileReason
} from '../../shared/audited-worktree-reason-mapping'
import { sqliteRowToTask, type AuditedTaskRow } from './audited-task-row-mapping'
import {
  getLiveAttempt,
  markAttemptFailedAmbiguous,
  markAttemptReleased,
  rebuildRegistryFromDatabase,
  type AuditedWorktreeAttemptRow
} from './audited-worktree-attempt-repository'
import { classifyEvidence } from './audited-worktree-evidence-classification'
import { readAuditedWorktreeEvidence } from './audited-worktree-evidence'
import { verifyAuditedWorktree } from './audited-worktree-drift-verifier'
import { finalizeProvisioning } from './audited-worktree-provisioning'
import { blockTaskForWorktreeFailure } from './audited-worktree-task-writes'
import { deriveManagedRootLayout } from './audited-worktree-managed-root'

export type ReconciledWorktreeTask = {
  taskId: string
  classification: ReconcileClass
  reasonCode: WorktreeReasonCode
}

// Post-triage states that legitimately require a worktree. A task here with no
// worktree identity predates Phase 3 provisioning.
const POST_TRIAGE_STATES: readonly AuditedTaskState[] = ['planning', 'ready_to_implement']

export function rebuildAuditedWorktreeRegistryFromDb(db: Database.Database): string[] {
  return rebuildRegistryFromDatabase(db)
}

function listTasks(db: Database.Database): AuditedTaskRow[] {
  const rows = db.prepare(`SELECT * FROM audited_tasks`).all() as Record<string, unknown>[]
  return rows.map(sqliteRowToTask)
}

export type ReconcileContext = {
  db: Database.Database
  workspaceRootForTask: (task: AuditedTaskRow) => string | null
  nowMs: () => number
}

export async function reconcileAuditedWorktrees(
  context: ReconcileContext
): Promise<ReconciledWorktreeTask[]> {
  const reconciled: ReconciledWorktreeTask[] = []
  for (const task of listTasks(context.db)) {
    const outcome = await reconcileOneTask(context, task)
    if (outcome) {
      reconciled.push(outcome)
    }
  }
  return reconciled
}

async function reconcileOneTask(
  context: ReconcileContext,
  task: AuditedTaskRow
): Promise<ReconciledWorktreeTask | null> {
  // Terminal and already-blocked tasks are left exactly as they are: a blocked
  // task keeps its original pre_block_state and reason, so repeated startup
  // passes never overwrite the first, truthful classification.
  if (task.state === 'blocked' || task.state === 'landed' || task.state === 'cancelled') {
    return null
  }

  const attempt = getLiveAttempt(context.db, task.id)
  if (attempt) {
    return reconcileLiveAttempt(context, task, attempt)
  }

  if (task.worktreePath && task.branchName && task.worktreeProvenance) {
    return reconcileProvisionedTask(context, task)
  }

  // Legacy: inferred from post-triage state plus missing worktree identity —
  // never from a provenance label, which describes only a verified worktree.
  if (POST_TRIAGE_STATES.includes(task.state) && !task.worktreePath) {
    blockTaskForWorktreeFailure(
      context.db,
      task.id,
      task.state,
      'worktree_never_provisioned',
      context.nowMs()
    )
    return classified(task.id, 'worktree_never_provisioned')
  }

  return null
}

async function reconcileLiveAttempt(
  context: ReconcileContext,
  task: AuditedTaskRow,
  attempt: AuditedWorktreeAttemptRow
): Promise<ReconciledWorktreeTask | null> {
  const evidence = await readAuditedWorktreeEvidence({
    sourceRepoPath: task.sourceRepoPath,
    intendedPath: attempt.intendedPath,
    intendedBranch: attempt.intendedBranch
  })
  const classification = classifyEvidence({
    attempt,
    evidence,
    taskId: task.id,
    repoId: task.repoId
  })

  if (classification.kind === 'all_absent') {
    // Nothing on disk or in Git to clean; releasing the guarded path is safe
    // exactly because every evidence channel was proven absent.
    markAttemptReleased(context.db, attempt.id, 'abandoned', null, context.nowMs())
    return null
  }

  if (classification.kind === 'exact_full_creation') {
    // A lost CAS means a live provisioning call already owns this attempt;
    // reporting nothing is correct — it is not this pass's outcome to record.
    finalizeProvisioning(context.db, task, attempt, context.nowMs())
    return null
  }

  // If this CAS loses, another writer already recorded a terminal outcome for
  // the attempt, so this pass must not also block the task on its own reading.
  if (
    !markAttemptFailedAmbiguous(context.db, attempt.id, classification.reasonCode, context.nowMs())
      .ok
  ) {
    return null
  }
  blockTaskForWorktreeFailure(
    context.db,
    task.id,
    task.state,
    classification.reasonCode,
    context.nowMs()
  )
  return classified(task.id, classification.reasonCode)
}

async function reconcileProvisionedTask(
  context: ReconcileContext,
  task: AuditedTaskRow
): Promise<ReconciledWorktreeTask | null> {
  const workspaceRoot = context.workspaceRootForTask(task)
  if (!workspaceRoot) {
    return null
  }
  const layout = deriveManagedRootLayout({
    workspaceRoot,
    sourceRepoPath: task.sourceRepoPath,
    repoId: task.repoId,
    taskId: task.id
  })
  if (!layout.ok) {
    blockTaskForWorktreeFailure(context.db, task.id, task.state, layout.reasonCode, context.nowMs())
    return classified(task.id, layout.reasonCode)
  }

  const verification = await verifyAuditedWorktree({
    worktreePath: task.worktreePath as string,
    expectedWorktreePath: task.worktreePath as string,
    managedRoot: layout.layout.managedRoot,
    branchName: task.branchName as string,
    baseCommit: task.baseCommit,
    sourceRepoCommonDir: task.sourceRepoCommonDir ?? ''
  })
  if (verification.ok) {
    return null
  }

  blockTaskForWorktreeFailure(
    context.db,
    task.id,
    task.state,
    verification.reasonCode,
    context.nowMs()
  )
  return classified(task.id, verification.reasonCode)
}

function classified(taskId: string, reasonCode: WorktreeReasonCode): ReconciledWorktreeTask {
  return {
    taskId,
    classification: mapWorktreeReasonToReconcileClass(reasonCode),
    reasonCode
  }
}

export { mapWorktreeReasonToReconcileReason }
