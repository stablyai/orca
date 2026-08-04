// The two user-triggered commands that never push (Phase 9 §6.1 / §5.5).
//
// Split from audited-publish-orchestration.ts so that file stays within its line
// budget without a max-lines suppression — and, more usefully, so the modules
// that CAN mutate a remote and the modules that CANNOT are separated by file.
//
// NEITHER FUNCTION HERE CONSTRUCTS A PUSH. recheckPublish builds only ls-remote;
// createReviewRequest touches no Git at all. That is enforced by what this module
// imports: the push builder and runLeasedPush are absent.
import { canRetryReviewRequest } from '../../shared/audited-publish-types'
import type {
  AuditedWorkflowCreateReviewRequestResult,
  AuditedWorkflowRecheckPublishResult
} from '../../shared/audited-workflow-command-types'
import type Database from '../sqlite/sync-database'
import { getAuditedTaskRepository } from './audited-task-service'
import { failPublishAttempt, getLatestPublishAttempt } from './audited-publish-attempt-repository'
import { classifyPublishEvidence } from './audited-publish-classification'
import {
  adoptPublished,
  broadcastIfProjectable,
  runReviewRequestPhase
} from './audited-publish-completion'
import { probeRemoteRef } from './audited-publish-remote'

/**
 * The user-triggered, READ-ONLY recovery path for an unconfirmed outcome.
 *
 * Classifies with the SAME function the startup sweep uses, so the two routes
 * cannot disagree. A retry push becomes possible only if this proves no_effect,
 * because admission requires that no `authorized` attempt exists.
 */
export async function recheckPublish(taskId: string): Promise<AuditedWorkflowRecheckPublishResult> {
  const repo = getAuditedTaskRepository()
  const db = repo.getDatabase()

  const attempt = getLatestPublishAttempt(db, taskId)
  if (!attempt || attempt.status !== 'authorized') {
    return { ok: false, kind: 'publish', reasonCode: 'illegal_transition' }
  }
  const task = repo.getTask(taskId)
  if (!task || !task.worktreePath) {
    return { ok: false, kind: 'publish', reasonCode: 'worktree_not_verified' }
  }

  const probe = await probeRemoteRef(
    task.worktreePath,
    attempt.intendedRemote,
    attempt.intendedBranch
  )
  const verdict = classifyPublishEvidence(attempt, { remote: probe })

  switch (verdict.kind) {
    case 'published': {
      const result = await adoptPublished(db, {
        taskId,
        attemptId: attempt.id,
        worktreePath: task.worktreePath,
        branchName: attempt.intendedBranch,
        remote: attempt.intendedRemote,
        pushedSha: verdict.pushedSha,
        title: task.title,
        draft: false
      })
      return {
        ok: true,
        classification: 'published',
        advisory: result.ok ? result.advisory : null
      }
    }
    case 'no_effect': {
      const wrote = failPublishAttempt(
        db,
        {
          attemptId: attempt.id,
          taskId,
          status: 'failed_no_effect',
          reasonCode: 'interrupted',
          block: false
        },
        Date.now()
      )
      if (!wrote) {
        // Someone else classified it first; report what is PERSISTED rather than
        // our own reading, so the UI never shows a verdict nobody stored.
        return storedClassification(db, taskId)
      }
      broadcastIfProjectable(taskId)
      return { ok: true, classification: 'no_effect', advisory: null }
    }
    case 'ambiguous': {
      const wrote = failPublishAttempt(
        db,
        {
          attemptId: attempt.id,
          taskId,
          status: 'failed_ambiguous',
          reasonCode: 'push_evidence_ambiguous',
          block: true
        },
        Date.now()
      )
      if (!wrote) {
        return storedClassification(db, taskId)
      }
      broadcastIfProjectable(taskId)
      return { ok: true, classification: 'ambiguous', advisory: null }
    }
    case 'unknown_remote': {
      // NOTHING is written: the attempt stays `authorized`, so Recheck remains
      // the only offered action and no second push can start.
      return { ok: true, classification: 'unknown_remote', advisory: null }
    }
  }
}

/** Reports what is actually persisted after losing a classification race. */
function storedClassification(
  db: Database.Database,
  taskId: string
): AuditedWorkflowRecheckPublishResult {
  const current = getLatestPublishAttempt(db, taskId)
  if (!current) {
    return { ok: false, kind: 'publish', reasonCode: 'lock_contended' }
  }
  const classification =
    current.status === 'completed'
      ? 'published'
      : current.status === 'failed_ambiguous'
        ? 'ambiguous'
        : current.status === 'authorized'
          ? 'unknown_remote'
          : 'no_effect'
  return { ok: true, classification, advisory: current.publishAdvisory }
}

/**
 * The separate creation retry. Re-runs P4 alone; NEVER pushes and never touches
 * Git refs. Admissible only for a retryable advisory, re-checked HERE rather
 * than trusted from the projection the renderer read.
 */
export async function createReviewRequest(
  taskId: string,
  options: { draft?: boolean } = {}
): Promise<AuditedWorkflowCreateReviewRequestResult> {
  const repo = getAuditedTaskRepository()
  const db = repo.getDatabase()

  const attempt = getLatestPublishAttempt(db, taskId)
  if (!attempt || attempt.status !== 'completed') {
    return { ok: false, kind: 'publish', reasonCode: 'illegal_transition' }
  }
  if (!canRetryReviewRequest(attempt.publishAdvisory)) {
    return { ok: false, kind: 'publish', reasonCode: 'illegal_transition' }
  }
  const task = repo.getTask(taskId)
  if (!task || !task.worktreePath) {
    return { ok: false, kind: 'publish', reasonCode: 'worktree_not_verified' }
  }

  const advisory = await runReviewRequestPhase(db, {
    taskId,
    attemptId: attempt.id,
    worktreePath: task.worktreePath,
    branchName: attempt.intendedBranch,
    remote: attempt.intendedRemote,
    title: task.title,
    draft: options.draft === true
  })
  broadcastIfProjectable(taskId)
  return { ok: true, advisory }
}
