import type { HostedReviewSubmissionComment } from '../../../src/shared/hosted-review-submission'
import type { MobileWebProviderReviewFile } from '../../../src/shared/mobile-web/provider-review-contract'
import {
  MobileWebProviderReviewSubmissionPayloadSchema,
  MobileWebProviderReviewSubmissionResultSchema,
  type MobileWebProviderReviewQueuedComment,
  type MobileWebProviderReviewSubmissionResult
} from '../../../src/shared/mobile-web/provider-review-submission-contract'
import type { RpcClient } from '../transport/rpc-client'
import { mobileRepoSelectorFromWorktreeId } from '../source-control/mobile-hosted-review-service'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import {
  assertCurrentRepositoryIdentity,
  readHostedReviewSummary,
  readProviderDetails
} from './mobile-web-provider-review-state'
import { sanitizeMobileWebProviderReviewDetails } from './mobile-web-provider-review-sanitizer'
import {
  githubProviderReviewTarget,
  gitLabProviderReviewPosition,
  gitLabProviderReviewTarget
} from './mobile-web-provider-review-targets'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

export async function executeMobileWebProviderReviewSubmission(
  input: unknown,
  client: RpcClient,
  workspaceAuthority: MobileWebWorkspaceAuthority
): Promise<MobileWebProviderReviewSubmissionResult> {
  const payload = MobileWebProviderReviewSubmissionPayloadSchema.parse(input)
  const hostWorkspaceId = workspaceAuthority.hostWorkspaceId(payload.workspaceId)
  await assertCurrentRepositoryIdentity(client, hostWorkspaceId, payload)
  const repo = mobileRepoSelectorFromWorktreeId(hostWorkspaceId)
  const summary = await readHostedReviewSummary(client, repo, payload)
  if (
    !summary ||
    summary.provider !== payload.provider ||
    summary.number !== payload.reviewNumber
  ) {
    throw new MobileWebBrokerError('conflict')
  }
  const details = await readProviderDetails(client, repo, summary)
  const review = sanitizeMobileWebProviderReviewDetails(summary, details)
  if (
    review.detailsState !== 'loaded' ||
    review.headSha !== payload.expectedReviewHead ||
    !review.allowedSubmissionActions.includes(payload.action)
  ) {
    throw new MobileWebBrokerError('conflict')
  }
  const comments = retainedSubmissionComments(review.files, payload.comments)
  await assertCurrentRepositoryIdentity(client, hostWorkspaceId, payload)
  workspaceAuthority.assertHostWorkspaceBinding(payload.workspaceId, hostWorkspaceId)
  const result = await submitProviderReview(client, repo, payload, details, comments)
  if (
    !result.ok ||
    !isRecord(result.result) ||
    result.result.ok !== true ||
    result.result.action !== payload.action ||
    result.result.submittedComments !== comments.length
  ) {
    throw new MobileWebBrokerError('host_error')
  }
  return MobileWebProviderReviewSubmissionResultSchema.parse({
    workspaceId: payload.workspaceId,
    provider: payload.provider,
    reviewNumber: payload.reviewNumber,
    expectedReviewHead: payload.expectedReviewHead,
    submissionId: payload.submissionId,
    action: payload.action,
    submittedCommentIds: payload.comments.map((comment) => comment.id),
    outcome: 'completed'
  })
}

function retainedSubmissionComments(
  files: readonly MobileWebProviderReviewFile[],
  comments: readonly MobileWebProviderReviewQueuedComment[]
): HostedReviewSubmissionComment[] {
  return comments.map((comment) => {
    const file = files.find((candidate) => candidate.path === comment.path)
    const startLine = comment.startLine ?? comment.line
    if (
      !file ||
      file.isBinary ||
      startLine > comment.line ||
      !file.commentableLines.includes(startLine) ||
      !file.commentableLines.includes(comment.line)
    ) {
      throw new MobileWebBrokerError('conflict')
    }
    return {
      body: comment.body,
      path: file.path,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      line: comment.line,
      ...(comment.startLine ? { startLine: comment.startLine } : {})
    }
  })
}

async function submitProviderReview(
  client: RpcClient,
  repo: string,
  payload: ReturnType<typeof MobileWebProviderReviewSubmissionPayloadSchema.parse>,
  details: unknown,
  comments: HostedReviewSubmissionComment[]
) {
  if (payload.provider === 'github') {
    const repository = githubProviderReviewTarget(details).prRepo
    if (!repository) {
      throw new MobileWebBrokerError('conflict')
    }
    return client.sendRequest('hostedReview.submit', {
      repo,
      provider: 'github',
      number: payload.reviewNumber,
      expectedHead: payload.expectedReviewHead,
      action: payload.action,
      summary: payload.summary,
      comments,
      repository
    })
  }
  if (payload.provider === 'gitlab' && payload.action === 'comment') {
    const projectRef = gitLabProviderReviewTarget(details).projectRef
    const position = gitLabProviderReviewPosition(details, payload.expectedReviewHead)
    if (!projectRef || !position) {
      throw new MobileWebBrokerError('conflict')
    }
    return client.sendRequest('hostedReview.submit', {
      repo,
      provider: 'gitlab',
      number: payload.reviewNumber,
      expectedHead: payload.expectedReviewHead,
      action: payload.action,
      summary: payload.summary,
      comments,
      projectRef,
      baseSha: position.baseSha,
      startSha: position.startSha
    })
  }
  throw new MobileWebBrokerError('unsupported_capability')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
