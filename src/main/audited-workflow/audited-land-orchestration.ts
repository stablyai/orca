// "Land" — the local integration lane (Phase 10).
//
// Ordering mirrors startPublish: nothing touches the user's source repository
// until the audited worktree is verified AND both bindings — the Phase 8 commit
// and the CONFIRMED Phase 9 publication — are proven inside the same transaction
// that authorizes the attempt.
//
// EVERY GIT AND FILESYSTEM CALL HAPPENS OUTSIDE A SQLITE TRANSACTION. The
// admission CAS closes before L1 begins, and each phase's evidence write is its
// own short transaction.
//
// NO REMOTE OPERATION EXISTS IN THIS LANE. That is enforced by what this module
// imports: no push builder, no ls-remote, no review adapter.
import type { LandingReasonCode } from '../../shared/audited-workflow-types'
import type { AuditedWorkflowLandResult } from '../../shared/audited-workflow-command-types'
import { getAuditedTaskRepository } from './audited-task-service'
import { verifyWorktreeForTask } from './audited-worktree-service'
import { hasLiveCodeAuditRun } from './audited-candidate-repository'
import { hasLiveExecutionRun } from './audited-execution-run-repository'
import { resolvePublishableCommitAttempt } from './audited-publish-attempt-repository'
import {
  authorizeLandAttempt,
  failLandAttempt,
  hasLivePublishAttempt,
  markRefUpdateCompleted,
  markRefUpdateStarted,
  markWorktreeUpdateCompleted,
  markWorktreeUpdateStarted,
  resolveLandablePublishAttempt
} from './audited-land-attempt-repository'
import { adoptLanded, broadcastIfProjectable } from './audited-land-completion'
import { runLandRefUpdate, runLandWorktreeUpdate } from './audited-land-git'
import {
  classifySourceRepoTip,
  verifyBranchCheckedOutHere,
  verifySourceRepoIdentity,
  verifySourceRepoReadiness
} from './audited-land-source-repo'
import { FULL_OID } from './audited-worktree-identity'

function landFailure(reasonCode: LandingReasonCode): AuditedWorkflowLandResult {
  return { ok: false, kind: 'landing', reasonCode }
}

/**
 * Runs the full landing protocol.
 *
 * L0 (source repo identity/readiness) -> admission CAS -> L1 (re-verify) ->
 * L2 (ref CAS) -> L3 (index+worktree) -> L4 (verify). L3 and L4 can only produce
 * advisories, because the land is durable once L2 succeeds.
 */
export async function startLand(taskId: string): Promise<AuditedWorkflowLandResult> {
  const repo = getAuditedTaskRepository()
  const db = repo.getDatabase()

  const snapshot = repo.getTask(taskId)
  if (!snapshot) {
    return landFailure('illegal_transition')
  }
  if (snapshot.state !== 'committed') {
    return landFailure('task_not_committed')
  }

  // Pre-flight busy checks. Truthful and fast; the authoritative re-check happens
  // inside authorizeLandAttempt's transaction.
  if (hasLiveExecutionRun(db, taskId)) {
    return landFailure('execution_in_progress')
  }
  if (hasLiveCodeAuditRun(db, taskId)) {
    return landFailure('code_audit_in_progress')
  }
  if (hasLivePublishAttempt(db, taskId)) {
    return landFailure('publish_in_progress')
  }
  if (snapshot.wslDistro !== null || snapshot.hostId !== 'local') {
    return landFailure('landing_host_unsupported')
  }

  // Read-only verification of the AUDITED worktree before anything else. NOTE
  // this AWAITS and reloads durable state, so `snapshot` is stale from here on.
  const verified = await verifyWorktreeForTask(taskId)
  if (!verified.ok) {
    return { ok: false, kind: 'worktree', reasonCode: verified.reasonCode }
  }

  // RELOAD. Everything below comes from THIS row.
  const task = repo.getTask(taskId)
  if (!task || task.state !== 'committed') {
    return landFailure('task_not_committed')
  }
  if (!task.committedSha || !FULL_OID.test(task.committedSha)) {
    return landFailure('committed_candidate_invalid')
  }
  if (
    !task.worktreePath ||
    !task.branchName ||
    task.worktreeVerifiedAt === null ||
    task.worktreeReasonCode !== null
  ) {
    return landFailure('worktree_not_verified')
  }
  if (!task.sourceRepoCommonDir) {
    return landFailure('source_repo_mismatch')
  }

  // THE PHASE 8 BINDING.
  const commitBinding = resolvePublishableCommitAttempt(db, taskId, task.committedSha)
  if (!commitBinding) {
    return landFailure('commit_attempt_not_completed')
  }

  // THE PHASE 9 PUBLICATION GATE. A local commit without a CONFIRMED publication
  // stops HERE, before a single source-repo read — landing writes the user's own
  // working tree, and unpublished work must never reach it.
  const publishBinding = resolveLandablePublishAttempt(db, taskId, task.committedSha)
  if (!publishBinding.ok) {
    return landFailure(publishBinding.reasonCode)
  }

  // ---- L0 — source repository identity, readiness, and tip classification. ----
  const identity = await verifySourceRepoIdentity({
    sourceRepoPath: task.sourceRepoPath,
    sourceRepoCommonDir: task.sourceRepoCommonDir
  })
  if (!identity.ok) {
    return landFailure(identity.reasonCode)
  }
  const readiness = await verifySourceRepoReadiness({
    sourceRepoPath: task.sourceRepoPath,
    branchName: task.branchName
  })
  if (!readiness.ok) {
    return landFailure(readiness.reasonCode)
  }
  const checkedOut = await verifyBranchCheckedOutHere({
    sourceRepoPath: task.sourceRepoPath,
    branchName: task.branchName
  })
  if (!checkedOut.ok) {
    return landFailure(checkedOut.reasonCode)
  }
  const tip = await classifySourceRepoTip({
    sourceRepoPath: task.sourceRepoPath,
    branchName: task.branchName,
    baseCommit: task.baseCommit,
    committedSha: task.committedSha
  })
  if (tip.kind === 'refused') {
    return landFailure(tip.reasonCode)
  }

  const authorized = authorizeLandAttempt(
    db,
    {
      taskId,
      commitAttemptId: commitBinding.attemptId,
      publishAttemptId: publishBinding.publishAttemptId,
      intendedSha: task.committedSha,
      intendedBranch: task.branchName,
      intendedBaseSha: task.baseCommit,
      sourceRepoPath: task.sourceRepoPath,
      sourceRepoCommonDir: task.sourceRepoCommonDir,
      expectedWorktreePath: task.worktreePath,
      expectedWorktreeVerifiedAt: task.worktreeVerifiedAt
    },
    Date.now()
  )
  if (!authorized.ok) {
    return landFailure(authorized.reasonCode)
  }
  broadcastIfProjectable(taskId)

  const attemptId = authorized.attemptId
  const sourceRepoPath = authorized.sourceRepoPath
  const committedSha = task.committedSha
  const baseCommit = task.baseCommit
  const branchName = task.branchName

  // IDEMPOTENCE: the source branch already carries the audited work, so there is
  // nothing to mutate. Adopt as `landed_recovered` — this is also what makes a
  // crash AFTER a previous ref update recoverable to a truthful terminal state.
  if (tip.kind === 'already_landed') {
    return finishAdopted(db, {
      taskId,
      attemptId,
      landedSha: committedSha,
      landedBaseSha: baseCommit,
      reasonCode: 'landed_recovered',
      advisory: null
    })
  }

  // ---- L1 — re-verify immediately before mutating. ----
  // The admission CAS closed before Git could run, and the user's own repo is
  // the least controlled surface this feature touches.
  const recheck = await verifySourceRepoReadiness({ sourceRepoPath, branchName })
  if (!recheck.ok) {
    return finishFailedAttempt(db, taskId, attemptId, recheck.reasonCode)
  }
  const recheckTip = await classifySourceRepoTip({
    sourceRepoPath,
    branchName,
    baseCommit,
    committedSha
  })
  if (recheckTip.kind !== 'fast_forward') {
    return finishFailedAttempt(
      db,
      taskId,
      attemptId,
      recheckTip.kind === 'refused' ? recheckTip.reasonCode : 'source_repo_already_at_candidate'
    )
  }

  // ---- L2 — the ONE narrowly authorized ref update. THE DURABLE BOUNDARY. ----
  markRefUpdateStarted(db, attemptId)
  const refUpdated = await runLandRefUpdate({
    sourceRepoPath,
    branchName,
    committedSha,
    expectedBaseSha: baseCommit
  })
  if (!refUpdated.ok) {
    return finishFailedAttempt(db, taskId, attemptId, refUpdated.reasonCode)
  }
  markRefUpdateCompleted(db, attemptId)

  // ---- L3 — index + working tree. ADVISORY ONLY from here. ----
  markWorktreeUpdateStarted(db, attemptId)
  const worktreeUpdated = await runLandWorktreeUpdate({
    sourceRepoPath,
    baseSha: baseCommit,
    committedSha
  })
  if (worktreeUpdated) {
    markWorktreeUpdateCompleted(db, attemptId)
  }

  // ---- L4 — post-land verification. Also advisory only. ----
  const advisory = worktreeUpdated
    ? await verifyAfterLand({ sourceRepoPath, branchName, committedSha })
    : 'worktree_update_failed'

  return finishAdopted(db, {
    taskId,
    attemptId,
    landedSha: committedSha,
    landedBaseSha: baseCommit,
    reasonCode: 'landed',
    advisory
  })
}

/**
 * L4 — did the source repo end up where we expect?
 *
 * Can only produce an advisory: the ref moved before this ran, so nothing it
 * observes can undo the land.
 */
async function verifyAfterLand(args: {
  sourceRepoPath: string
  branchName: string
  committedSha: string
}): Promise<'worktree_verify_failed' | 'source_repo_drifted' | null> {
  const tip = await classifySourceRepoTip({
    sourceRepoPath: args.sourceRepoPath,
    branchName: args.branchName,
    baseCommit: args.committedSha,
    committedSha: args.committedSha
  })
  if (tip.kind !== 'already_landed') {
    return 'worktree_verify_failed'
  }
  const readiness = await verifySourceRepoReadiness({
    sourceRepoPath: args.sourceRepoPath,
    branchName: args.branchName
  })
  return readiness.ok ? null : 'source_repo_drifted'
}

function finishAdopted(
  db: ReturnType<ReturnType<typeof getAuditedTaskRepository>['getDatabase']>,
  args: Parameters<typeof adoptLanded>[1]
): AuditedWorkflowLandResult {
  const adopted = adoptLanded(db, args)
  if (!adopted) {
    // The ref DID move, so the land is durable; a bookkeeping loss here must not
    // be reported as a failed land. Recovery reconciles it from evidence.
    broadcastIfProjectable(args.taskId)
    return landFailure('lock_contended')
  }
  return { ok: true, advisory: args.advisory }
}

/**
 * Fails an attempt whose source ref provably never moved.
 *
 * The task returns to `committed` rather than `blocked`: nothing about the local
 * commit or its publication is in doubt, so Land is simply offered again.
 */
function finishFailedAttempt(
  db: ReturnType<ReturnType<typeof getAuditedTaskRepository>['getDatabase']>,
  taskId: string,
  attemptId: string,
  reasonCode: LandingReasonCode
): AuditedWorkflowLandResult {
  const block = reasonCode === 'landing_evidence_ambiguous'
  failLandAttempt(
    db,
    {
      attemptId,
      taskId,
      status: block ? 'failed_ambiguous' : 'failed_no_effect',
      reasonCode,
      block
    },
    Date.now()
  )
  broadcastIfProjectable(taskId)
  return landFailure(reasonCode)
}

// The read-only recovery command lives in its own module (see its header);
// re-exported so callers still import the landing lane from one place.
export * from './audited-land-recovery-commands'
