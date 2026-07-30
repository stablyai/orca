// Provisioning orchestration: claim -> git worktree add -> verify -> finalize.
//
// The task stays `selected` throughout — Phase 3 adds no lifecycle state. Only
// audited_worktree_attempts.status tracks provisioning progress, which keeps the
// schema migration additive.
//
// SQLite and Git are two independent durable stores; there is no atomic
// transaction spanning them. Every crash point is instead made recoverable by
// inspection (see audited-worktree-evidence-classification.ts).
import type Database from '../sqlite/sync-database'
import type {
  WorktreeAttemptStatus,
  WorktreeReasonCode
} from '../../shared/audited-worktree-types'
import type { AuditedTaskRow } from './audited-task-row-mapping'
import {
  advanceAttemptStatus,
  claimAttempt,
  getAttemptById,
  getLatestAttempt,
  getLiveAttempt,
  hasBlockingAttemptEvidence,
  markAttemptFailedAmbiguous,
  markAttemptReleased,
  type AuditedWorktreeAttemptRow
} from './audited-worktree-attempt-repository'
import {
  buildWorktreeAddArgv,
  runAuditedWorktreeAdd
} from './audited-worktree-commands'
import { classifyEvidence } from './audited-worktree-evidence-classification'
import { readAuditedWorktreeEvidence, readCommonDir } from './audited-worktree-evidence'
import { verifyAuditedWorktree } from './audited-worktree-drift-verifier'
import {
  deriveAuditedBranchName,
  deriveAuditedWorktreeId,
  deriveProvenanceId,
  FULL_OID
} from './audited-worktree-identity'
import {
  canonicalizeAllowingMissing,
  prepareManagedRoot
} from './audited-worktree-managed-root'

export type ProvisionResult =
  | { ok: true; worktreePath: string; branchName: string }
  | { ok: false; reasonCode: WorktreeReasonCode }
  | { ok: false; contended: true }

export type ProvisionContext = {
  db: Database.Database
  task: AuditedTaskRow
  workspaceRoot: string
  nowMs: () => number
}

// Test seam: lets a deterministic test park provisioning between the real
// worktree-add command and verification/finalization, which is exactly the
// window the guard must already cover.
let afterWorktreeAddHook: (() => Promise<void>) | undefined
export function setAfterWorktreeAddHookForTests(hook: (() => Promise<void>) | undefined): void {
  afterWorktreeAddHook = hook
}

function isProvisioned(task: AuditedTaskRow): boolean {
  return Boolean(task.worktreePath && task.branchName && task.worktreeProvenance)
}

// Attempt ids currently being driven by a provisioning call IN THIS PROCESS.
//
// Why this is needed and a DB status is not enough: `claimed` means the same
// thing on disk whether the owner is alive (a concurrent caller mid-Git-work)
// or dead (a crash remnant). Classifying a live attempt would read its
// half-created worktree as ambiguous and poison an attempt about to succeed;
// refusing to classify a crash remnant would make it unrecoverable. Liveness is
// only knowable in-process, so it is tracked here rather than inferred.
const inFlightAttemptIds = new Set<string>()

export function isAttemptInFlight(attemptId: string): boolean {
  return inFlightAttemptIds.has(attemptId)
}

/**
 * Ensures a verified worktree exists for the task, provisioning one if needed.
 * Idempotent: an already-finalized, still-verifying worktree returns ok without
 * touching Git beyond the read-only verification.
 */
export async function ensureAuditedWorktree(context: ProvisionContext): Promise<ProvisionResult> {
  const { db, task } = context

  if (isProvisioned(task)) {
    const verified = await verifyExisting(context, task)
    return verified
  }

  // Enforced HERE, not only in the recovery layer: a failed_ambiguous attempt
  // left real Git state on disk that Phase 3 never cleans automatically, so no
  // caller may claim a fresh attempt for this task/path.
  if (hasBlockingAttemptEvidence(db, task.id)) {
    return { ok: false, reasonCode: 'provision_evidence_ambiguous' }
  }

  if (!FULL_OID.test(task.baseCommit)) {
    return { ok: false, reasonCode: 'base_commit_unresolvable' }
  }

  const layout = prepareManagedRoot({
    workspaceRoot: context.workspaceRoot,
    sourceRepoPath: task.sourceRepoPath,
    repoId: task.repoId,
    taskId: task.id
  })
  if (!layout.ok) {
    return { ok: false, reasonCode: layout.reasonCode }
  }

  const commonDir = await readCommonDir(task.sourceRepoPath)
  if (!commonDir) {
    return { ok: false, reasonCode: 'worktree_unreadable' }
  }

  const branchName = deriveAuditedBranchName(task.id)
  const worktreePath = layout.layout.worktreePath
  const provenanceId = deriveProvenanceId({
    taskId: task.id,
    repoId: task.repoId,
    canonicalCommonDir: commonDir,
    baseCommit: task.baseCommit,
    branchName,
    canonicalWorktreePath: worktreePath
  })

  const claimed = claimAttempt(
    db,
    {
      taskId: task.id,
      intendedBranch: branchName,
      intendedPath: worktreePath,
      intendedCommonDir: commonDir,
      intendedBaseCommit: task.baseCommit,
      provenanceId
    },
    context.nowMs()
  )
  if (!claimed.ok) {
    // An attempt already exists. Distinguish two very different situations:
    //
    //  - A LIVE attempt owned by a concurrent caller in this process. Its
    //    worktree is mid-creation, so classifying it now would read a partial
    //    state as "ambiguous" and poison an attempt that is about to succeed.
    //    Report contention and let the owner finish.
    //  - A non-live attempt (crash remnant, or a winner that already
    //    finalized). Nobody is driving it, so classifying the durable evidence
    //    is safe and is what makes crash recovery adoptable.
    const existing = getLatestAttempt(db, task.id)
    if (!existing) {
      return { ok: false, contended: true }
    }
    if (isAttemptInFlight(existing.id)) {
      return { ok: false, contended: true }
    }
    return classifyFailedAttempt(context, existing)
  }

  inFlightAttemptIds.add(claimed.attempt.id)
  try {
    return await runProvisioningAttempt(context, claimed.attempt, layout.layout.managedRoot)
  } finally {
    // Cleared even on throw, so a crash-simulating test (or a real exception)
    // leaves the attempt classifiable rather than permanently "live".
    inFlightAttemptIds.delete(claimed.attempt.id)
  }
}

async function verifyExisting(
  context: ProvisionContext,
  task: AuditedTaskRow
): Promise<ProvisionResult> {
  const layout = prepareManagedRoot({
    workspaceRoot: context.workspaceRoot,
    sourceRepoPath: task.sourceRepoPath,
    repoId: task.repoId,
    taskId: task.id
  })
  if (!layout.ok) {
    return { ok: false, reasonCode: layout.reasonCode }
  }
  const verification = await verifyAuditedWorktree({
    worktreePath: task.worktreePath as string,
    expectedWorktreePath: task.worktreePath as string,
    managedRoot: layout.layout.managedRoot,
    branchName: task.branchName as string,
    baseCommit: task.baseCommit,
    sourceRepoCommonDir: task.sourceRepoCommonDir ?? ''
  })
  if (!verification.ok) {
    return { ok: false, reasonCode: verification.reasonCode }
  }
  return {
    ok: true,
    worktreePath: task.worktreePath as string,
    branchName: task.branchName as string
  }
}

async function runProvisioningAttempt(
  context: ProvisionContext,
  attempt: AuditedWorktreeAttemptRow,
  managedRoot: string
): Promise<ProvisionResult> {
  const { db, task } = context

  const argv = buildWorktreeAddArgv(
    attempt.intendedBranch,
    attempt.intendedPath,
    attempt.intendedBaseCommit
  )
  const added = await runAuditedWorktreeAdd(argv, task.sourceRepoPath)

  if (afterWorktreeAddHook) {
    await afterWorktreeAddHook()
  }

  if (!added.ok) {
    // A non-zero exit is NOT proof Git made no durable change: it can create the
    // branch and admin record before failing mid-checkout. Classify before
    // choosing any terminal status. The raw error stays local — never projected.
    console.error('[auditedWorkflow] git worktree add failed:', added.error)
    return classifyFailedAttempt(context, attempt)
  }

  // Every status CAS below is load-bearing: losing one means a concurrent
  // reconciliation took ownership of this attempt's outcome, and this call must
  // stop rather than continue writing over it.
  if (!advanceAttemptStatus(db, attempt.id, 'claimed', 'created', context.nowMs()).ok) {
    return { ok: false, contended: true }
  }

  const verification = await verifyAuditedWorktree({
    worktreePath: attempt.intendedPath,
    expectedWorktreePath: attempt.intendedPath,
    managedRoot,
    branchName: attempt.intendedBranch,
    baseCommit: attempt.intendedBaseCommit,
    sourceRepoCommonDir: attempt.intendedCommonDir
  })
  if (!verification.ok) {
    // markAttemptFailedAmbiguous is itself CAS-guarded on a live status; if it
    // loses, the concurrent writer already recorded a terminal outcome.
    if (!markAttemptFailedAmbiguous(db, attempt.id, verification.reasonCode, context.nowMs()).ok) {
      return { ok: false, contended: true }
    }
    return { ok: false, reasonCode: verification.reasonCode }
  }

  if (!advanceAttemptStatus(db, attempt.id, 'created', 'verified', context.nowMs()).ok) {
    return { ok: false, contended: true }
  }
  if (!finalizeProvisioning(db, task, attempt, context.nowMs()).ok) {
    return { ok: false, contended: true }
  }
  return { ok: true, worktreePath: attempt.intendedPath, branchName: attempt.intendedBranch }
}

/**
 * Runs full evidence classification after a failed or interrupted worktree-add
 * and selects the matching terminal status. Only the all-absent branch releases
 * the guarded path; every other outcome keeps it and preserves all Git state.
 */
export async function classifyFailedAttempt(
  context: ProvisionContext,
  attempt: AuditedWorktreeAttemptRow
): Promise<ProvisionResult> {
  const { db, task } = context
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
    if (
      !markAttemptReleased(
        db,
        attempt.id,
        'failed_no_effect',
        'git_worktree_add_failed',
        context.nowMs()
      ).ok
    ) {
      return { ok: false, contended: true }
    }
    return { ok: false, reasonCode: 'git_worktree_add_failed' }
  }

  if (classification.kind === 'exact_full_creation') {
    // Adopt despite the non-zero result: the evidence proves the worktree is
    // exactly what this attempt intended. finalizeProvisioning performs the
    // status CAS itself, so no separate markAttemptFinalized call is needed —
    // a second unguarded update here would reintroduce the overwrite race.
    if (!finalizeProvisioning(db, task, attempt, context.nowMs()).ok) {
      // Losing the CAS to a writer that reached the SAME desired end state
      // (finalized) is success, not contention — the caller's goal is met and
      // reporting failure would be untrue. Any other terminal status means a
      // different outcome was recorded, which this call must not override.
      const current = getAttemptById(db, attempt.id)
      if (current?.status === 'finalized') {
        return { ok: true, worktreePath: attempt.intendedPath, branchName: attempt.intendedBranch }
      }
      return { ok: false, contended: true }
    }
    return { ok: true, worktreePath: attempt.intendedPath, branchName: attempt.intendedBranch }
  }

  if (!markAttemptFailedAmbiguous(db, attempt.id, classification.reasonCode, context.nowMs()).ok) {
    return { ok: false, contended: true }
  }
  return { ok: false, reasonCode: classification.reasonCode }
}

// The only attempt statuses from which finalization is legal. Notably absent:
// failed_ambiguous and failed_no_effect — a concurrent reconciliation that
// classified this attempt as ambiguous and blocked the task must never be
// silently overwritten by the provisioning call that started it.
const FINALIZABLE_ATTEMPT_STATUSES: readonly WorktreeAttemptStatus[] = [
  'claimed',
  'created',
  'verified',
  // Idempotent re-finalization (adoption re-runs) stays legal.
  'finalized'
]

export type FinalizeProvisioningResult = { ok: true } | { ok: false; contended: true }

/**
 * Atomically finalizes the attempt AND writes the task's worktree identity,
 * guarded on the attempt still being in an allowed state.
 *
 * Race safety: the attempt UPDATE runs FIRST with an explicit status CAS inside
 * one BEGIN IMMEDIATE transaction. If a concurrent reconciliation already moved
 * the attempt to failed_ambiguous, the CAS matches zero rows and the whole
 * transaction rolls back — leaving that reconciliation's block intact rather
 * than clobbering it with a bogus "provisioned" identity.
 */
export function finalizeProvisioning(
  db: Database.Database,
  task: AuditedTaskRow,
  attempt: AuditedWorktreeAttemptRow,
  nowMs: number
): FinalizeProvisioningResult {
  const placeholders = FINALIZABLE_ATTEMPT_STATUSES.map(() => '?').join(', ')
  db.exec('BEGIN IMMEDIATE')
  try {
    const attemptUpdate = db
      .prepare(
        `UPDATE audited_worktree_attempts
            SET status = 'finalized', reason_code = NULL, finalized_at_ms = ?
          WHERE id = ? AND status IN (${placeholders})`
      )
      .run(nowMs, attempt.id, ...FINALIZABLE_ATTEMPT_STATUSES)
    if (attemptUpdate.changes !== 1) {
      // Another writer owns this attempt's outcome now. Write nothing.
      db.exec('ROLLBACK')
      return { ok: false, contended: true }
    }

    db.prepare(
      `UPDATE audited_tasks
          SET worktree_id = ?,
              worktree_path = ?,
              branch_name = ?,
              worktree_provenance = 'orca_audited_v1',
              worktree_provisioned_at_ms = ?,
              source_repo_common_dir = ?,
              worktree_reason_code = NULL,
              worktree_verified_at_ms = ?,
              updated_at_ms = ?
        WHERE id = ?`
    ).run(
      deriveAuditedWorktreeId(task.repoId, canonicalizeAllowingMissing(attempt.intendedPath)),
      attempt.intendedPath,
      attempt.intendedBranch,
      nowMs,
      attempt.intendedCommonDir,
      nowMs,
      nowMs,
      task.id
    )
    db.exec('COMMIT')
    return { ok: true }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export { getLiveAttempt }
