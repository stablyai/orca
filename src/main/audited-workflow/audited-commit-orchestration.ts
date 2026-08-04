// "Approve / Revoke / Commit" (Phase 8).
//
// Ordering mirrors startCodeAudit: nothing mutates the repository until the
// worktree is verified AND the approval is proven live inside the same
// transaction that authorizes the attempt. A commit can therefore only ever
// happen for a tree a human approved while it was current.
//
// EVERY GIT AND FILESYSTEM CALL HAPPENS OUTSIDE A SQLITE TRANSACTION. The
// admission CAS closes before Phase A0 begins, and each phase's evidence write is
// its own short transaction.
import { app } from 'electron'
import type { CommitReasonCode } from '../../shared/audited-commit-types'
import type { AuditedWorkflowCommitResult } from '../../shared/audited-workflow-command-types'
import { getAuditedTaskRepository, getTaskProjection } from './audited-task-service'
import { broadcastAuditedTaskChanged } from './audited-workflow-broadcast'
import { verifyWorktreeForTask } from './audited-worktree-service'
import { getCurrentCandidate } from './audited-candidate-repository'
import { hasLiveExecutionRun } from './audited-execution-run-repository'
import { getPendingApproval } from './audited-approval-repository'
import { hasLiveCodeAuditRun } from './audited-candidate-repository'
import { canonicalizeCommitMessage } from './audited-commit-message'
import {
  authorizeCommitAttempt,
  completeCommitAttempt,
  failCommitAttempt,
  markPromotionCompleted,
  recordCreatedCommit,
  recordPostCommitAdvisory
} from './audited-commit-attempt-repository'
import { promoteApprovedCandidate } from './audited-commit-promotion'
import {
  readBranchTip,
  runCommitTree,
  runIndexRefresh,
  runRefUpdateCas
} from './audited-commit-git'
import { verifyWorktreeAfterCommit } from './audited-commit-post-verify'
import { releaseTaskStoresAndDelete } from './audited-candidate-store-gc'

export type CommitCommandResult = AuditedWorkflowCommitResult

function broadcastIfProjectable(taskId: string): void {
  const projection = getTaskProjection(taskId)
  if (projection) {
    broadcastAuditedTaskChanged(projection)
  }
}

function commitFailure(reasonCode: CommitReasonCode): CommitCommandResult {
  return { ok: false, kind: 'commit', reasonCode }
}

/**
 * Runs the full commit protocol.
 *
 * Phase A0 (promote) -> A (commit-tree) -> B (update-ref CAS) -> C (index
 * refresh) -> D (post-commit verification). Phases C and D can only produce
 * advisories, never failures, because the commit is durable once B succeeds.
 */
export async function startCommit(taskId: string, message: string): Promise<CommitCommandResult> {
  const repo = getAuditedTaskRepository()
  const db = repo.getDatabase()

  const snapshot = repo.getTask(taskId)
  if (!snapshot || snapshot.state !== 'awaiting_human_approval') {
    return commitFailure('illegal_transition')
  }

  // Pre-flight busy checks. Truthful and fast; the authoritative re-check happens
  // inside authorizeCommitAttempt's transaction.
  if (hasLiveExecutionRun(db, taskId)) {
    return commitFailure('execution_in_progress')
  }
  if (hasLiveCodeAuditRun(db, taskId)) {
    return commitFailure('code_audit_in_progress')
  }

  const canonical = canonicalizeCommitMessage(message)
  if (!canonical.ok) {
    return commitFailure(canonical.reasonCode)
  }

  // Read-only verification before anything mutates. NOTE this AWAITS and reloads
  // durable state, so `snapshot` is stale from here on.
  const verified = await verifyWorktreeForTask(taskId)
  if (!verified.ok) {
    return { ok: false, kind: 'worktree', reasonCode: verified.reasonCode }
  }

  // RELOAD. Everything below comes from THIS row.
  const task = repo.getTask(taskId)
  if (!task || task.state !== 'awaiting_human_approval') {
    return commitFailure('illegal_transition')
  }
  if (
    !task.worktreePath ||
    !task.branchName ||
    task.worktreeVerifiedAt === null ||
    task.worktreeReasonCode !== null
  ) {
    return commitFailure('worktree_not_verified')
  }

  const approval = getPendingApproval(db, taskId)
  if (!approval) {
    return commitFailure('no_approval')
  }
  const nowMs = Date.now()
  if (nowMs >= approval.expiresAt) {
    return commitFailure('approval_expired')
  }

  const candidate = getCurrentCandidate(db, taskId)
  if (!candidate || candidate.id !== approval.candidateId) {
    return commitFailure('candidate_superseded')
  }
  if (candidate.treeOid !== approval.approvedTreeOid) {
    return commitFailure('candidate_drift')
  }

  const authorized = authorizeCommitAttempt(
    db,
    {
      taskId,
      approvalId: approval.id,
      intendedTreeOid: approval.approvedTreeOid,
      intendedParent: task.baseCommit,
      intendedBranch: task.branchName,
      intendedMessageSha: canonical.sha256,
      expectedWorktreePath: task.worktreePath,
      expectedWorktreeVerifiedAt: task.worktreeVerifiedAt
    },
    nowMs
  )
  if (!authorized.ok) {
    return commitFailure(authorized.reasonCode)
  }
  broadcastIfProjectable(taskId)

  const userDataPath = app.getPath('userData')
  const attemptId = authorized.attemptId
  const worktreePath = authorized.worktreePath

  // ---- Phase A0 — promote the approved graph into the real store. ----
  const promoted = await promoteApprovedCandidate(db, {
    attemptId,
    candidateId: candidate.id,
    approvedTreeOid: approval.approvedTreeOid,
    userDataPath,
    worktreePath,
    sourceRepoPath: task.sourceRepoPath,
    baseCommit: task.baseCommit,
    wslDistro: task.wslDistro,
    hostId: task.hostId
  })
  if (!promoted.ok) {
    // Nothing referenced anything: the ref never moved. failed_no_effect is the
    // honest status, and the task returns to awaiting_human_approval so the human
    // can re-approve (the approval was consumed at admission).
    return finishFailedAttempt(db, taskId, attemptId, promoted.reasonCode)
  }
  markPromotionCompleted(db, attemptId)

  // ---- Phase A — the commit object, no ref touched. ----
  const created = await runCommitTree({
    userDataPath,
    attemptId,
    worktreePath,
    treeOid: approval.approvedTreeOid,
    parentOid: task.baseCommit,
    message: canonical.text
  })
  if (!created.ok) {
    return finishFailedAttempt(db, taskId, attemptId, created.reasonCode)
  }
  // Recorded BEFORE update-ref: this is what makes the A->B window classifiable.
  recordCreatedCommit(db, attemptId, created.commitSha)

  // ---- Phase B — the single narrowly authorized ref update. ----
  const tip = await readBranchTip(worktreePath, task.branchName)
  if (tip !== task.baseCommit) {
    return finishFailedAttempt(db, taskId, attemptId, 'branch_ref_moved')
  }
  const refUpdated = await runRefUpdateCas({
    worktreePath,
    branchName: task.branchName,
    newCommitSha: created.commitSha,
    expectedOldSha: task.baseCommit
  })
  if (!refUpdated.ok) {
    return finishFailedAttempt(db, taskId, attemptId, refUpdated.reasonCode)
  }

  const completed = completeCommitAttempt(
    db,
    { attemptId, taskId, commitSha: created.commitSha },
    Date.now()
  )
  if (!completed.ok) {
    // The ref DID move, so the commit is durable; a bookkeeping loss here must
    // not be reported as a failed commit. Recovery reconciles it from evidence.
    broadcastIfProjectable(taskId)
    return commitFailure(completed.reasonCode)
  }
  broadcastIfProjectable(taskId)

  // ---- Phases C and D — advisory only. The commit is durable from here. ----
  await runPostCommitPhases(db, {
    attemptId,
    taskId,
    userDataPath,
    worktreePath,
    sourceRepoPath: task.sourceRepoPath,
    branchName: task.branchName,
    committedSha: created.commitSha,
    committedTreeOid: approval.approvedTreeOid,
    wslDistro: task.wslDistro,
    hostId: task.hostId
  })
  broadcastIfProjectable(taskId)

  // Terminal state reached: release the candidate store's accounting inside a
  // transaction, then delete the directory. A deletion failure is inert.
  try {
    releaseTaskStoresAndDelete(db, taskId, userDataPath)
  } catch (error) {
    console.error('[auditedWorkflow] Candidate store release failed after commit:', error)
  }

  return { ok: true }
}

/**
 * Phases C and D. Neither can fail a commit — both record advisories only.
 */
async function runPostCommitPhases(
  db: ReturnType<ReturnType<typeof getAuditedTaskRepository>['getDatabase']>,
  args: {
    attemptId: string
    taskId: string
    userDataPath: string
    worktreePath: string
    sourceRepoPath: string
    branchName: string
    committedSha: string
    committedTreeOid: string
    wslDistro: string | null
    hostId: string
  }
): Promise<void> {
  // Phase C — reconcile the REAL index, or `git status` shows spurious MM/D.
  const refreshed = await runIndexRefresh(args.worktreePath)

  // Phase D — did the worktree change under us while we committed?
  const verification = await verifyWorktreeAfterCommit({
    attemptId: args.attemptId,
    userDataPath: args.userDataPath,
    worktreePath: args.worktreePath,
    sourceRepoPath: args.sourceRepoPath,
    branchName: args.branchName,
    committedSha: args.committedSha,
    committedTreeOid: args.committedTreeOid,
    wslDistro: args.wslDistro,
    hostId: args.hostId
  })

  const advisory = verification.advisory ?? (refreshed ? null : 'index_refresh_failed')
  recordPostCommitAdvisory(db, args.attemptId, advisory, refreshed)
}

/**
 * Fails an attempt whose ref provably never moved.
 *
 * The task returns to awaiting_human_approval rather than `blocked`: nothing is
 * wrong with the work, the human simply needs to approve again (the approval was
 * consumed at admission and cannot be reused).
 */
function finishFailedAttempt(
  db: ReturnType<ReturnType<typeof getAuditedTaskRepository>['getDatabase']>,
  taskId: string,
  attemptId: string,
  reasonCode: CommitReasonCode
): CommitCommandResult {
  failCommitAttempt(
    db,
    {
      attemptId,
      taskId,
      status: 'failed_no_effect',
      reasonCode,
      toState: 'awaiting_human_approval',
      blockedReasonCode: null
    },
    Date.now()
  )
  broadcastIfProjectable(taskId)
  return commitFailure(reasonCode)
}
