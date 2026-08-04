// "Publish / Recheck outcome / Create review request" (Phase 9).
//
// Ordering mirrors startCommit: nothing reaches the network until the worktree is
// verified AND the Phase 8 binding is proven inside the same transaction that
// authorizes the attempt.
//
// EVERY GIT AND NETWORK CALL HAPPENS OUTSIDE A SQLITE TRANSACTION. The admission
// CAS closes before P1 begins, and each phase's evidence write is its own short
// transaction.
//
// THE TASK NEVER LEAVES `committed` on any success or no-effect path. A push that
// fails or cannot be classified must never make the local commit look undone.
import type { PublishReasonCode } from '../../shared/audited-publish-types'
import type { AuditedWorkflowPublishResult } from '../../shared/audited-workflow-command-types'
import { getAuditedTaskRepository } from './audited-task-service'
import { verifyWorktreeForTask } from './audited-worktree-service'
import {
  authorizePublishAttempt,
  failPublishAttempt,
  getLatestPublishAttempt,
  markPushStarted,
  recordPublishLease,
  resolvePublishableCommitAttempt
} from './audited-publish-attempt-repository'
import { classifyPublishEvidence } from './audited-publish-classification'
import { adoptPublished, broadcastIfProjectable } from './audited-publish-completion'
import { runLeasedPush, verifyLocalPublishIdentity } from './audited-publish-git'
import { probeRemoteRef, resolvePublishRemote } from './audited-publish-remote'

function publishFailure(reasonCode: PublishReasonCode): AuditedWorkflowPublishResult {
  return { ok: false, kind: 'publish', reasonCode }
}

/**
 * Runs the full publish protocol.
 *
 * P0 (verify local) -> P1 (remote + lease) -> P2 (leased push) -> P3 (confirm)
 * -> P4 (review request). Once P3 confirms, the attempt is permanently
 * `completed` and P4 can only produce advisories.
 */
export async function startPublish(
  taskId: string,
  options: { draft?: boolean } = {}
): Promise<AuditedWorkflowPublishResult> {
  const repo = getAuditedTaskRepository()
  const db = repo.getDatabase()

  const snapshot = repo.getTask(taskId)
  if (!snapshot) {
    return publishFailure('illegal_transition')
  }
  if (snapshot.state !== 'committed') {
    return publishFailure('task_not_committed')
  }

  // Read-only verification before anything reaches the network. NOTE this AWAITS
  // and reloads durable state, so `snapshot` is stale from here on.
  const verified = await verifyWorktreeForTask(taskId)
  if (!verified.ok) {
    return { ok: false, kind: 'worktree', reasonCode: verified.reasonCode }
  }

  // RELOAD. Everything below comes from THIS row.
  const task = repo.getTask(taskId)
  if (!task || task.state !== 'committed') {
    return publishFailure('task_not_committed')
  }
  if (!task.committedSha) {
    return publishFailure('committed_sha_missing')
  }
  if (
    !task.worktreePath ||
    !task.branchName ||
    task.worktreeVerifiedAt === null ||
    task.worktreeReasonCode !== null
  ) {
    return publishFailure('worktree_not_verified')
  }
  if (task.wslDistro !== null || task.hostId !== 'local') {
    return publishFailure('publish_host_unsupported')
  }

  const binding = resolvePublishableCommitAttempt(db, taskId, task.committedSha)
  if (!binding) {
    return publishFailure('commit_attempt_not_completed')
  }

  // ---- P0 — re-verify local identity immediately before any network call. ----
  const identity = await verifyLocalPublishIdentity({
    worktreePath: task.worktreePath,
    branchName: task.branchName,
    committedSha: task.committedSha
  })
  if (!identity.ok) {
    return publishFailure(identity.reasonCode)
  }

  // ---- P1a — resolve the remote (read-only, network-free). ----
  const remote = await resolvePublishRemote(task.worktreePath, task.branchName)
  if (!remote.ok) {
    return publishFailure(remote.reasonCode)
  }

  const authorized = authorizePublishAttempt(
    db,
    {
      taskId,
      commitAttemptId: binding.attemptId,
      intendedSha: task.committedSha,
      intendedBranch: task.branchName,
      intendedRemote: remote.remote,
      expectedWorktreePath: task.worktreePath,
      expectedWorktreeVerifiedAt: task.worktreeVerifiedAt
    },
    Date.now()
  )
  if (!authorized.ok) {
    return publishFailure(authorized.reasonCode)
  }
  broadcastIfProjectable(taskId)

  const attemptId = authorized.attemptId
  const worktreePath = authorized.worktreePath
  const branchName = task.branchName
  const committedSha = task.committedSha

  // ---- P1b — capture the lease. ----
  const lease = await probeRemoteRef(worktreePath, remote.remote, branchName)
  if (!lease.ok) {
    return finishFailedAttempt(db, taskId, attemptId, lease.reasonCode)
  }
  recordPublishLease(db, attemptId, {
    remote: remote.remote,
    expectedRemoteSha: lease.sha
  })

  // IDEMPOTENCE: the remote already carries exactly what we would push, so there
  // is nothing to mutate. Skip P2 entirely and adopt.
  if (lease.sha === committedSha) {
    return await adoptPublished(db, {
      taskId,
      attemptId,
      worktreePath,
      branchName,
      remote: remote.remote,
      pushedSha: committedSha,
      title: task.title,
      draft: options.draft === true
    })
  }

  // ---- P2 — the ONE network mutation. ----
  markPushStarted(db, attemptId)
  const pushed = await runLeasedPush({
    worktreePath,
    remote: remote.remote,
    branchName,
    sha: committedSha,
    expectedRemoteSha: lease.sha
  })

  // ---- P3 — confirm. A push exit code proves nothing either way. ----
  const confirm = await probeRemoteRef(worktreePath, remote.remote, branchName)
  if (!confirm.ok) {
    // We pushed and cannot look. The attempt STAYS `authorized` so no second
    // push can start; Recheck outcome is the only way forward.
    broadcastIfProjectable(taskId)
    return publishFailure(pushed.ok ? 'remote_ref_unreadable' : pushed.reasonCode)
  }
  if (confirm.sha === committedSha) {
    return await adoptPublished(db, {
      taskId,
      attemptId,
      worktreePath,
      branchName,
      remote: remote.remote,
      pushedSha: committedSha,
      title: task.title,
      draft: options.draft === true
    })
  }

  // The push did not land. Classify from the same evidence table recovery uses.
  const attempt = getLatestPublishAttempt(db, taskId)
  const verdict = attempt
    ? classifyPublishEvidence(attempt, { remote: confirm })
    : ({ kind: 'ambiguous' } as const)
  if (verdict.kind === 'ambiguous') {
    return finishAmbiguousAttempt(db, taskId, attemptId)
  }
  return finishFailedAttempt(db, taskId, attemptId, pushed.ok ? 'push_failed' : pushed.reasonCode)
}

/**
 * Fails an attempt whose push provably did not land.
 *
 * The task stays `committed` and is NOT blocked: nothing about the local commit
 * is in doubt, and Publish becomes available again.
 */
function finishFailedAttempt(
  db: ReturnType<ReturnType<typeof getAuditedTaskRepository>['getDatabase']>,
  taskId: string,
  attemptId: string,
  reasonCode: PublishReasonCode
): AuditedWorkflowPublishResult {
  failPublishAttempt(
    db,
    { attemptId, taskId, status: 'failed_no_effect', reasonCode, block: false },
    Date.now()
  )
  broadcastIfProjectable(taskId)
  return publishFailure(reasonCode)
}

function finishAmbiguousAttempt(
  db: ReturnType<ReturnType<typeof getAuditedTaskRepository>['getDatabase']>,
  taskId: string,
  attemptId: string
): AuditedWorkflowPublishResult {
  failPublishAttempt(
    db,
    {
      attemptId,
      taskId,
      status: 'failed_ambiguous',
      reasonCode: 'push_evidence_ambiguous',
      block: true
    },
    Date.now()
  )
  broadcastIfProjectable(taskId)
  return publishFailure('push_evidence_ambiguous')
}

// The two commands that can NEVER push live in their own module (see its header);
// re-exported so callers still import the publish lane from one place.
export * from './audited-publish-recovery-commands'
