// Wires the Phase 3 worktree modules to the repository and Orca settings. This
// is the single entry point IPC/orchestration call into for provisioning,
// verification, recovery, and startup reconciliation.
import { computeWorkspaceRoot, getWorktreePathSettings } from '../ipc/worktree-logic'
import type { Store } from '../persistence'
import type { Repo } from '../../shared/types'
import type { AuditedTaskState } from '../../shared/audited-workflow-types'
import type { WorktreeReasonCode } from '../../shared/audited-worktree-types'
import { getAuditedTaskRepository } from './audited-task-service'
import type { AuditedTaskRow } from './audited-task-row-mapping'
import { rebuildRegistryFromDatabase } from './audited-worktree-attempt-repository'
import {
  markAuditedWorktreeRegistryUnavailable,
  requireAuditedWorktreeRegistry
} from './audited-worktree-registry'
import { ensureAuditedWorktree } from './audited-worktree-provisioning'
import { verifyAuditedWorktree } from './audited-worktree-drift-verifier'
import { deriveManagedRootLayout } from './audited-worktree-managed-root'
import {
  reconcileAuditedWorktrees,
  type ReconciledWorktreeTask
} from './audited-worktree-reconciliation'
import { recoverAuditedWorktree, type WorktreeRecoveryResult } from './audited-worktree-recovery'
import { blockTaskForWorktreeFailure } from './audited-worktree-task-writes'
import { hasLivePlanReviewRun } from './audited-plan-review-run-repository'

let storeRef: Store | undefined

export function setAuditedWorktreeStore(store: Store | undefined): void {
  storeRef = store
}

function nowMs(): number {
  return Date.now()
}

function resolveWorkspaceRoot(task: AuditedTaskRow): string | null {
  if (!storeRef) {
    return null
  }
  const repo = storeRef.getRepos().find((candidate: Repo) => candidate.id === task.repoId)
  if (!repo) {
    return null
  }
  const settings = storeRef.getSettings()
  const pathSettings = getWorktreePathSettings(repo, settings)
  return computeWorkspaceRoot(repo.path, pathSettings)
}

export type EnsureWorktreeOutcome =
  | { ok: true }
  | { ok: false; reasonCode: WorktreeReasonCode }
  | { ok: false; contended: true }

/**
 * Ensures a verified worktree before the caller proceeds. On failure the task is
 * blocked with the generic worktree block code plus the detailed reason, so the
 * renderer can offer recovery only where it is legal.
 */
export async function ensureWorktreeForTask(taskId: string): Promise<EnsureWorktreeOutcome> {
  const repo = getAuditedTaskRepository()
  const task = repo.getTask(taskId)
  if (!task) {
    return { ok: false, reasonCode: 'worktree_never_provisioned' }
  }

  // REFUSE while an agent run owns this task's worktree.
  //
  // This is the ONLY supported writer that can change a task's worktree identity
  // (path, branch, provenance, verification marker) after provisioning, and it
  // is reachable from the renderer through auditedWorkflow:verifyWorktree with
  // nothing but a taskId. A live Codex plan review has already had that identity
  // admitted into its run row and is executing with it as its cwd; re-pointing
  // the row underneath would strand the running process in a directory the task
  // no longer claims.
  //
  // Refusing preserves the same admission invariant startPlanReviewRun enforces,
  // without a new task state: `awaiting_plan_review` with a live review row is
  // already a distinct, queryable condition. Cancel the review first — that path
  // kills the process and finalizes the row, after which this returns to normal.
  if (hasLivePlanReviewRun(repo.getDatabase(), taskId)) {
    return { ok: false, contended: true }
  }

  // Why block rather than just report: an unresolvable workspace root is a
  // durable configuration failure, not a transient read. Leaving the task
  // `selected` would let the UI keep offering Start Triage with no recovery
  // affordance, and would hide the failure from startup reconciliation.
  const workspaceRoot = resolveWorkspaceRoot(task)
  if (!workspaceRoot) {
    return blockAndReport(repo, task, 'managed_root_unavailable')
  }

  const result = await ensureAuditedWorktree({
    db: repo.getDatabase(),
    task,
    workspaceRoot,
    nowMs
  })

  if (result.ok) {
    return { ok: true }
  }
  if ('contended' in result) {
    return { ok: false, contended: true }
  }

  return blockAndReport(repo, task, result.reasonCode)
}

/**
 * CAS-blocks the task and reports the reason. A lost CAS means the task moved
 * since it was read (e.g. a concurrent reconciliation already blocked it), so
 * this call reports contention rather than claiming an outcome it did not write.
 */
function blockAndReport(
  repo: ReturnType<typeof getAuditedTaskRepository>,
  task: AuditedTaskRow,
  reasonCode: WorktreeReasonCode
): EnsureWorktreeOutcome {
  // Re-read: `task` was captured before the (possibly long) provisioning work,
  // so its state may be stale. The CAS below must be keyed on what the row
  // actually holds now, otherwise it could match on an outdated assumption.
  const current = repo.getTask(task.id) ?? task

  // Already blocked: a concurrent writer recorded a terminal classification
  // first, and that one wins (blockTaskForWorktreeFailure refuses to re-block).
  // Report the PERSISTED reason, never this call's own — returning `reasonCode`
  // here would tell the caller something the task row does not actually say,
  // and the renderer gates recovery affordances on exactly that value.
  if (current.state === 'blocked') {
    if (current.worktreeReasonCode === null) {
      // Blocked by a non-worktree phase, or mid-write. There is no truthful
      // worktree reason to report, so surface contention rather than invent one.
      return { ok: false, contended: true }
    }
    return { ok: false, reasonCode: current.worktreeReasonCode }
  }

  const blocked = blockTaskForWorktreeFailure(
    repo.getDatabase(),
    task.id,
    current.state as AuditedTaskState,
    reasonCode,
    nowMs()
  )
  if (!blocked.ok) {
    return { ok: false, contended: true }
  }
  return { ok: false, reasonCode }
}

export type VerifyWorktreeOutcome = { ok: true } | { ok: false; reasonCode: WorktreeReasonCode }

/**
 * Read-only verification of an ALREADY-provisioned worktree. Unlike
 * ensureWorktreeForTask this never provisions, never blocks, and never writes to
 * any table — so an already-blocked task keeps its existing block and the caller
 * receives the ACTUAL drift reason instead of `contended`.
 *
 * Why this exists as a separate entry point: ensureWorktreeForTask's failure
 * path routes through blockAndReport, which on an already-blocked task with a
 * null worktree_reason_code (i.e. one blocked by execution rather than by a
 * worktree failure) can only report contention — it has no truthful persisted
 * reason to return. Execution retry needs the real reason, and must not mutate
 * a task it is only inspecting.
 *
 * There is deliberately no `contended` arm: nothing is claimed and no CAS is
 * attempted, so contention is not a possible outcome.
 *
 * The returned reason is NOT persisted anywhere. Callers must not describe it as
 * such, and it is not admissible to worktree recovery.
 */
export async function verifyWorktreeForTask(taskId: string): Promise<VerifyWorktreeOutcome> {
  const repo = getAuditedTaskRepository()
  const task = repo.getTask(taskId)
  if (!task) {
    return { ok: false, reasonCode: 'worktree_never_provisioned' }
  }

  const workspaceRoot = resolveWorkspaceRoot(task)
  if (!workspaceRoot) {
    return { ok: false, reasonCode: 'managed_root_unavailable' }
  }

  // deriveManagedRootLayout, NOT prepareManagedRoot: the latter mkdirs, which
  // would make this function a writer.
  const layout = deriveManagedRootLayout({
    workspaceRoot,
    sourceRepoPath: task.sourceRepoPath,
    repoId: task.repoId,
    taskId: task.id
  })
  if (!layout.ok) {
    return { ok: false, reasonCode: layout.reasonCode }
  }

  if (!task.worktreePath || !task.branchName || !task.worktreeProvenance) {
    return { ok: false, reasonCode: 'worktree_never_provisioned' }
  }

  const verification = await verifyAuditedWorktree({
    worktreePath: task.worktreePath,
    expectedWorktreePath: task.worktreePath,
    managedRoot: layout.layout.managedRoot,
    branchName: task.branchName,
    baseCommit: task.baseCommit,
    sourceRepoCommonDir: task.sourceRepoCommonDir ?? ''
  })
  if (!verification.ok) {
    return { ok: false, reasonCode: verification.reasonCode }
  }
  return { ok: true }
}

export async function recoverWorktreeForTask(taskId: string): Promise<WorktreeRecoveryResult> {
  const repo = getAuditedTaskRepository()
  const task = repo.getTask(taskId)
  if (!task) {
    return { ok: false, notAdmissible: true }
  }
  const workspaceRoot = resolveWorkspaceRoot(task)
  if (!workspaceRoot) {
    return { ok: false, reasonCode: 'managed_root_unavailable' }
  }
  return recoverAuditedWorktree({
    db: repo.getDatabase(),
    task,
    workspaceRoot,
    nowMs
  })
}

/**
 * Rebuilds the guard registry from both durable sources. MUST run before any Git
 * mutation handler is registered — see registerAuditedWorkflowHandlers.
 *
 * FAILS CLOSED. A rebuild error does not abort IPC registration (that would
 * leave the app with no handlers at all), but it marks the registry unavailable
 * so every Git/worktree mutation boundary refuses until a later rebuild
 * succeeds. Continuing with an empty registry would silently disable protection
 * for every existing audited worktree.
 *
 * The raw error is logged locally and never surfaced — callers receive only the
 * boolean outcome, and the guard's refusal text is fixed and sanitized.
 */
export function rebuildAuditedWorktreeRegistry(): { ok: boolean } {
  // From this point the guard's answer must come from a real rebuild: a failure
  // below leaves the registry unavailable rather than permissive.
  requireAuditedWorktreeRegistry()
  try {
    rebuildRegistryFromDatabase(getAuditedTaskRepository().getDatabase())
    return { ok: true }
  } catch (error) {
    // rebuildRegistryFromDatabase already dropped the cached paths and marked
    // the registry unavailable; this call also covers a failure to obtain the
    // database handle at all, which never reaches that function.
    console.error('[auditedWorkflow] Rebuilding the worktree guard registry failed:', error)
    markAuditedWorktreeRegistryUnavailable()
    return { ok: false }
  }
}

export async function reconcileAuditedWorktreesOnStartup(): Promise<ReconciledWorktreeTask[]> {
  const repo = getAuditedTaskRepository()
  return reconcileAuditedWorktrees({
    db: repo.getDatabase(),
    workspaceRootForTask: resolveWorkspaceRoot,
    nowMs
  })
}
