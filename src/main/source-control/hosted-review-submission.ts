import type {
  HostedReviewSubmissionInput,
  HostedReviewSubmissionResult
} from '../../shared/hosted-review-submission'
import type { IssueSourcePreference } from '../../shared/repo-types'
import { submitGitHubPullRequestReview } from '../github/pr-review-submission'
import { addMRComment, addMRInlineComment } from '../gitlab/client'
import {
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from './hosted-review-git-options'

export async function submitHostedReview(
  repoPath: string,
  input: HostedReviewSubmissionInput,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<HostedReviewSubmissionResult> {
  if (input.provider === 'github') {
    return submitGitHubPullRequestReview({
      repoPath,
      repository: input.repository,
      number: input.number,
      expectedHead: input.expectedHead,
      action: input.action,
      summary: input.summary,
      comments: input.comments,
      connectionId,
      localGitOptions: getHostedReviewLocalGitOptions(options)
    })
  }
  return submitGitLabMergeRequestReview(repoPath, input, preference, connectionId, options)
}

async function submitGitLabMergeRequestReview(
  repoPath: string,
  input: Extract<HostedReviewSubmissionInput, { provider: 'gitlab' }>,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<HostedReviewSubmissionResult> {
  let submittedComments = 0
  const localGitOptions = getHostedReviewLocalGitOptions(options)
  for (const comment of input.comments) {
    const result = await addMRInlineComment(
      repoPath,
      input.number,
      {
        body: comment.body,
        path: comment.path,
        ...(comment.oldPath ? { oldPath: comment.oldPath } : {}),
        line: comment.line,
        baseSha: input.baseSha,
        startSha: input.startSha,
        headSha: input.expectedHead
      },
      preference,
      connectionId,
      input.projectRef,
      localGitOptions
    )
    if (!result.ok) {
      return submissionFailure(result.error, submittedComments)
    }
    submittedComments += 1
  }
  if (input.summary) {
    const result = await addMRComment(
      repoPath,
      input.number,
      input.summary,
      preference,
      connectionId,
      input.projectRef,
      localGitOptions
    )
    if (!result.ok) {
      return submissionFailure(result.error, submittedComments)
    }
  }
  return { ok: true, action: input.action, submittedComments }
}

function submissionFailure(error: string, submittedComments: number): HostedReviewSubmissionResult {
  return {
    ok: false,
    code: submittedComments > 0 ? 'partial' : 'provider_error',
    submittedComments,
    error
  }
}
