import type { IssueSourcePreference } from '../../shared/repository/repo-types'
import {
  encodedGiteaRepoPath,
  giteaAuthRequiredResult,
  giteaWriteUsesGt,
  runGiteaGtCommand,
  gtPullCommand,
  writeGiteaJson,
  type GiteaMutationResult,
  type GiteaProjectRef
} from './pull-request-mutation-transport'
import {
  giteaPositiveIntegerText,
  isResolvedGiteaPull,
  resolveGiteaPullTarget
} from './pull-request-review-target'
import type { GiteaRepoRef, LocalGitExecOptions } from './repository-ref'
import type { GiteaDiscussionResolveResult, GiteaReviewDecision } from '../../shared/gitea-types'

export type { GiteaCommentResult, GiteaPRInlineCommentInput } from './pull-request-review-comments'
export { addGiteaPRComment, addGiteaPRInlineComment } from './pull-request-review-comments'
export type { GiteaDiscussionResolveResult }

async function runGtPull(
  repo: GiteaRepoRef,
  argsAfterPull: string[],
  repoPath: string,
  localGitOptions: LocalGitExecOptions
): Promise<GiteaMutationResult> {
  const args = gtPullCommand(repo, argsAfterPull)
  if (!args) {
    return giteaAuthRequiredResult()
  }
  const posted = await runGiteaGtCommand(args, localGitOptions, repoPath)
  return posted.ok ? { ok: true } : posted
}

export async function resolveGiteaPRDiscussion(
  repoPath: string,
  index: number,
  discussionId: string,
  markResolved: boolean,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: GiteaProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GiteaDiscussionResolveResult> {
  const commentId = giteaPositiveIntegerText(discussionId)
  if (!commentId) {
    return { ok: false, error: 'Discussion id must be a positive integer.' }
  }
  const resolved = await resolveGiteaPullTarget(
    repoPath,
    index,
    preference,
    connectionId,
    projectRef,
    localGitOptions
  )
  if (!isResolvedGiteaPull(resolved)) {
    return resolved
  }
  const action = markResolved ? 'resolve' : 'unresolve'
  if (giteaWriteUsesGt(resolved.repo)) {
    return runGtPull(
      resolved.repo,
      ['review', action, resolved.indexArg, commentId],
      repoPath,
      localGitOptions
    )
  }
  return writeGiteaJson(
    resolved.repo,
    `/repos/${encodedGiteaRepoPath(resolved.repo)}/pulls/comments/${commentId}/${action}`,
    'POST',
    {}
  )
}

export async function submitGiteaPRReview(
  repoPath: string,
  index: number,
  decision: GiteaReviewDecision,
  body?: string,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: GiteaProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GiteaMutationResult> {
  const comment = body?.trim() ?? ''
  if (decision === 'request_changes' && !comment) {
    return { ok: false, error: 'A comment is required when requesting changes.' }
  }
  const resolved = await resolveGiteaPullTarget(
    repoPath,
    index,
    preference,
    connectionId,
    projectRef,
    localGitOptions
  )
  if (!isResolvedGiteaPull(resolved)) {
    return resolved
  }
  const event = decision === 'approve' ? 'APPROVED' : 'REQUEST_CHANGES'
  if (giteaWriteUsesGt(resolved.repo)) {
    const flag = decision === 'approve' ? '--approve' : '--request-changes'
    const args = ['review', resolved.indexArg, flag]
    if (comment) {
      args.push('-b', comment)
    }
    return runGtPull(resolved.repo, args, repoPath, localGitOptions)
  }
  return writeGiteaJson(
    resolved.repo,
    `/repos/${encodedGiteaRepoPath(resolved.repo)}/pulls/${resolved.indexArg}/reviews`,
    'POST',
    {
      event,
      body: comment
    }
  )
}
