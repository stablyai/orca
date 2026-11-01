import type { IssueSourcePreference } from '../../shared/repo-types'
import {
  encodedGiteaRepoPath,
  giteaAuthRequiredResult,
  giteaWriteUsesTea,
  runGiteaTeaCommand,
  teaPullCommand,
  writeGiteaJson,
  type GiteaMutationFailure,
  type GiteaMutationResult,
  type GiteaProjectRef
} from './pull-request-mutation-transport'
import {
  giteaPositiveIntegerText,
  isResolvedGiteaPull,
  resolveGiteaPullTarget
} from './pull-request-review-target'
import type { GiteaRepoRef, LocalGitExecOptions } from './repository-ref'

export type { GiteaCommentResult, GiteaPRInlineCommentInput } from './pull-request-review-comments'
export { addGiteaPRComment, addGiteaPRInlineComment } from './pull-request-review-comments'

export type GiteaDiscussionResolveResult = { ok: true } | GiteaMutationFailure

async function runTeaPull(
  repo: GiteaRepoRef,
  argsAfterPull: string[],
  repoPath: string,
  localGitOptions: LocalGitExecOptions
): Promise<GiteaMutationResult> {
  const args = teaPullCommand(repo, argsAfterPull)
  if (!args) {
    return giteaAuthRequiredResult()
  }
  const posted = await runGiteaTeaCommand(args, localGitOptions, repoPath)
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
  if (giteaWriteUsesTea(resolved.repo)) {
    return runTeaPull(resolved.repo, [action, commentId], repoPath, localGitOptions)
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
  decision: 'approve' | 'request_changes',
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
  if (giteaWriteUsesTea(resolved.repo)) {
    const verb = decision === 'approve' ? 'approve' : 'reject'
    return runTeaPull(
      resolved.repo,
      comment ? [verb, resolved.indexArg, comment] : [verb, resolved.indexArg],
      repoPath,
      localGitOptions
    )
  }
  return writeGiteaJson(
    resolved.repo,
    `/repos/${encodedGiteaRepoPath(resolved.repo)}/pulls/${resolved.indexArg}/reviews`,
    'POST',
    {
      event: decision === 'approve' ? 'APPROVED' : 'REQUEST_CHANGES',
      ...(comment ? { body: comment } : {})
    }
  )
}
