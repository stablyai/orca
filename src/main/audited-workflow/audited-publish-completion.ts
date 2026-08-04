// What happens once P3 has CONFIRMED the remote carries the audited sha
// (Phase 9).
//
// Split from audited-publish-orchestration.ts so that file stays within its line
// budget without a max-lines suppression, and so the "publish is durable from
// here" rule lives in one place: both the live protocol and the recovery paths
// call adoptPublished, so neither can accidentally record a confirmed push as
// anything other than `completed`.
import type { PublishAdvisoryCode } from '../../shared/audited-publish-types'
import type { AuditedWorkflowPublishResult } from '../../shared/audited-workflow-command-types'
import type Database from '../sqlite/sync-database'
import { getTaskProjection } from './audited-task-service'
import { broadcastAuditedTaskChanged } from './audited-workflow-broadcast'
import { completePublishAttempt, recordReviewOutcome } from './audited-publish-attempt-repository'
import { resolveBaseBranch } from './audited-publish-git'
import { requestReview } from './audited-publish-review'

export function broadcastIfProjectable(taskId: string): void {
  const projection = getTaskProjection(taskId)
  if (projection) {
    broadcastAuditedTaskChanged(projection)
  }
}

export type ReviewPhaseArgs = {
  taskId: string
  attemptId: string
  worktreePath: string
  branchName: string
  remote: string
  title: string
  draft: boolean
}

/**
 * P4 — the review request. ADVISORY ONLY: the publish is durable before this
 * runs and stays `completed` under every outcome, so this returns an advisory
 * rather than a result that could express failure.
 */
export async function runReviewRequestPhase(
  db: Database.Database,
  args: ReviewPhaseArgs
): Promise<PublishAdvisoryCode> {
  const baseBranch = await resolveBaseBranch(args.worktreePath, args.remote)
  if (!baseBranch) {
    // We cannot name a base, so we do not guess one. Deferred, never failed.
    recordReviewOutcome(db, {
      attemptId: args.attemptId,
      taskId: args.taskId,
      advisory: 'review_request_deferred',
      provider: null,
      number: null,
      url: null,
      created: false
    })
    return 'review_request_deferred'
  }

  const outcome = await requestReview({
    repoPath: args.worktreePath,
    branch: args.branchName,
    baseBranch,
    title: args.title,
    // Deliberately empty: the commit message is renderer-authored input that
    // travels main-ward only and is never echoed back out.
    body: '',
    draft: args.draft
  })
  recordReviewOutcome(db, {
    attemptId: args.attemptId,
    taskId: args.taskId,
    advisory: outcome.advisory,
    provider: outcome.provider,
    number: outcome.number,
    url: outcome.url,
    created: outcome.created
  })
  return outcome.advisory
}

/**
 * P3 confirmed: the attempt becomes permanently `completed`, then P4 runs and
 * can only record an advisory.
 *
 * This is the ONLY function that marks a publish complete, so "a confirmed push
 * is never reported as failed" holds for the live protocol and the recovery
 * paths alike.
 */
export async function adoptPublished(
  db: Database.Database,
  args: ReviewPhaseArgs & { pushedSha: string }
): Promise<AuditedWorkflowPublishResult> {
  completePublishAttempt(
    db,
    { attemptId: args.attemptId, taskId: args.taskId, pushedSha: args.pushedSha },
    Date.now()
  )
  broadcastIfProjectable(args.taskId)

  const advisory = await runReviewRequestPhase(db, args)
  broadcastIfProjectable(args.taskId)
  return { ok: true, advisory }
}
