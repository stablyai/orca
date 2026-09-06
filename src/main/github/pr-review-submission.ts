import type {
  HostedReviewSubmissionAction,
  HostedReviewSubmissionComment,
  HostedReviewSubmissionResult
} from '../../shared/hosted-review-submission'
import type { GitHubRepositoryIdentity } from '../../shared/github/pull-request-types'
import { resolveGitHubRepoExecution } from './github-api-repository'
import {
  acquire,
  classifyGhError,
  ghExecFileAsync,
  release,
  type LocalGitExecOptions
} from './gh-utils'

export async function submitGitHubPullRequestReview(args: {
  repoPath: string
  repository: GitHubRepositoryIdentity
  number: number
  expectedHead: string
  action: HostedReviewSubmissionAction
  summary: string
  comments: HostedReviewSubmissionComment[]
  connectionId?: string | null
  localGitOptions?: LocalGitExecOptions
}): Promise<HostedReviewSubmissionResult> {
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    args.repoPath,
    args.repository,
    args.connectionId,
    args.localGitOptions
  )
  if (!ownerRepo) {
    return submissionFailure('invalid_target', 'Could not resolve the review repository')
  }
  await acquire()
  try {
    const payload = {
      commit_id: args.expectedHead,
      event: githubReviewEvent(args.action),
      ...(args.summary ? { body: args.summary } : {}),
      ...(args.comments.length > 0
        ? { comments: args.comments.map(githubReviewCommentPayload) }
        : {})
    }
    const { stdout } = await ghExecFileAsync(
      [
        'api',
        '-X',
        'POST',
        `repos/${ownerRepo.owner}/${ownerRepo.repo}/pulls/${args.number}/reviews`,
        '--input',
        '-'
      ],
      { ...ghOptions, stdin: JSON.stringify(payload), idempotent: false }
    )
    const response = JSON.parse(stdout) as { id?: unknown }
    if (typeof response.id !== 'number' || !Number.isSafeInteger(response.id) || response.id < 1) {
      return submissionFailure('provider_error', 'GitHub returned an invalid review response')
    }
    return { ok: true, action: args.action, submittedComments: args.comments.length }
  } catch (error) {
    const message = classifyGhError(error instanceof Error ? error.message : String(error)).message
    return submissionFailure('provider_error', message)
  } finally {
    release()
  }
}

function githubReviewEvent(
  action: HostedReviewSubmissionAction
): 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES' {
  if (action === 'approve') {
    return 'APPROVE'
  }
  return action === 'request-changes' ? 'REQUEST_CHANGES' : 'COMMENT'
}

function githubReviewCommentPayload(comment: HostedReviewSubmissionComment) {
  return {
    path: comment.path,
    line: comment.line,
    side: 'RIGHT' as const,
    body: comment.body,
    ...(comment.startLine !== undefined && comment.startLine !== comment.line
      ? { start_line: comment.startLine, start_side: 'RIGHT' as const }
      : {})
  }
}

function submissionFailure(
  code: Extract<HostedReviewSubmissionResult, { ok: false }>['code'],
  error: string
): HostedReviewSubmissionResult {
  return { ok: false, code, submittedComments: 0, error }
}
