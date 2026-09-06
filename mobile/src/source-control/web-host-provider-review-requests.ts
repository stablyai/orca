import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type {
  MobileWebProviderReview,
  MobileWebProviderReviewResult
} from '../../../src/shared/mobile-web/provider-review-contract'
import type { WebHostProviderReviewEligibilityCache } from './web-host-provider-review-creation'
import {
  createWebHostProviderReviewCache,
  loadWebHostProviderReview,
  readWebHostGitHubRepositoryEligibility,
  type WebHostProviderReviewCache
} from './web-host-provider-review-loader'
import {
  handleWebHostProviderReviewMutation,
  WEB_HOST_PROVIDER_REVIEW_MUTATION_METHODS
} from './web-host-provider-review-mutations'
import type { WebHostSourceControlStatusSnapshot } from './web-host-source-control-status-snapshot'

type RequestParams = Record<string, unknown>

export { createWebHostProviderReviewCache, type WebHostProviderReviewCache }

export async function handleWebHostProviderReviewRequest(args: {
  client: MobileWebBridgeClient
  workspaceId: string
  method: string
  params: RequestParams
  cache: WebHostProviderReviewCache
  eligibilityCache: WebHostProviderReviewEligibilityCache
  statusSnapshot: WebHostSourceControlStatusSnapshot
}): Promise<unknown | typeof WEB_HOST_PROVIDER_REVIEW_UNHANDLED> {
  const { client, workspaceId, method, params, cache, eligibilityCache, statusSnapshot } = args
  if (
    !PROVIDER_READ_METHODS.has(method) &&
    !WEB_HOST_PROVIDER_REVIEW_MUTATION_METHODS.has(method)
  ) {
    return WEB_HOST_PROVIDER_REVIEW_UNHANDLED
  }
  if (method === 'github.repoSlug') {
    return readWebHostGitHubRepositoryEligibility(
      client,
      workspaceId,
      eligibilityCache,
      statusSnapshot
    )
  }
  const loaded = await loadWebHostProviderReview(
    client,
    workspaceId,
    cache,
    eligibilityCache,
    statusSnapshot
  )
  const review = loaded.review
  if (method === 'hostedReview.forBranch') {
    return review ? hostedReviewSummary(review) : null
  }
  if (method === 'github.prForBranch') {
    return review?.provider === 'github' ? githubPrInfo(review) : null
  }
  if (method === 'github.workItemDetails') {
    return review?.provider === 'github' ? githubWorkItemDetails(review) : null
  }
  if (method === 'github.prChecks') {
    return review?.provider === 'github' ? githubChecks(review) : []
  }
  if (
    (method === 'github.listAssignableUsers' || method === 'github.prCheckDetails') &&
    review?.provider === 'github'
  ) {
    return queryGitHubReview(client, workspaceId, loaded, review, method, params)
  }
  const result = await handleWebHostProviderReviewMutation({
    client,
    workspaceId,
    method,
    params,
    loaded,
    commentIds: cache.commentIds
  })
  cache.key = null
  return result
}

export const WEB_HOST_PROVIDER_REVIEW_UNHANDLED = Symbol('provider-review-unhandled')

const PROVIDER_READ_METHODS = new Set([
  'github.repoSlug',
  'hostedReview.forBranch',
  'github.prForBranch',
  'github.workItemDetails',
  'github.prChecks',
  'github.prCheckDetails',
  'github.listAssignableUsers'
])

function hostedReviewSummary(review: MobileWebProviderReview) {
  return {
    provider: review.provider,
    number: review.number,
    title: review.title,
    state: review.state,
    url: '',
    status: review.checksStatus,
    updatedAt: review.updatedAt,
    mergeable: review.mergeable,
    reviewDecision: review.reviewDecision,
    autoMergeEnabled: review.autoMergeEnabled,
    autoMergeAllowed: review.autoMergeAllowed,
    mergeStateStatus: review.mergeStateStatus,
    headSha: review.headSha
  }
}

function githubPrInfo(review: MobileWebProviderReview) {
  return {
    number: review.number,
    title: review.title,
    state: review.state === 'draft' ? 'open' : review.state,
    url: '',
    checksStatus: review.checksStatus,
    updatedAt: review.updatedAt,
    mergeable: review.mergeable,
    reviewDecision: review.reviewDecision,
    autoMergeEnabled: review.autoMergeEnabled,
    autoMergeAllowed: review.autoMergeAllowed,
    mergeStateStatus: review.mergeStateStatus,
    mergeMethodSettings: review.mergeMethodSettings,
    headSha: review.headSha
  }
}

function githubWorkItemDetails(review: MobileWebProviderReview) {
  return {
    item: {
      id: `hosted-review-${review.number}`,
      type: 'pr',
      number: review.number,
      title: review.title,
      state: review.state,
      url: '',
      labels: [],
      updatedAt: review.updatedAt,
      author: review.author,
      headSha: review.headSha,
      reviewDecision: review.reviewDecision,
      mergeable: review.mergeable,
      reviewRequests: review.reviewRequests.map((user) => ({ ...user, avatarUrl: '' })),
      latestReviews: review.latestReviews.map((summary) => ({
        ...summary,
        avatarUrl: null
      }))
    },
    body: review.body,
    comments: review.comments.map((comment, index) => ({
      id: index + 1,
      author: comment.author,
      authorAvatarUrl: '',
      body: comment.body,
      createdAt: comment.createdAt,
      url: '',
      ...(comment.path ? { path: comment.path } : {}),
      ...(comment.threadId ? { threadId: comment.threadId } : {}),
      ...(comment.threadState ? { isResolved: comment.threadState === 'resolved' } : {}),
      ...(comment.threadState ? { isOutdated: comment.threadState === 'outdated' } : {}),
      ...(comment.line ? { line: comment.line } : {}),
      ...(comment.startLine ? { startLine: comment.startLine } : {}),
      ...(comment.isBot !== undefined ? { isBot: comment.isBot } : {})
    })),
    headSha: review.headSha,
    files: review.files.map((file) => ({
      path: file.path,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      isBinary: file.isBinary,
      reviewCommentLineNumbers: file.commentableLines
    }))
  }
}

function githubChecks(review: MobileWebProviderReview) {
  return review.checks.map((check) => ({ ...check, url: null }))
}

async function queryGitHubReview(
  client: MobileWebBridgeClient,
  workspaceId: string,
  loaded: MobileWebProviderReviewResult,
  review: MobileWebProviderReview,
  method: string,
  params: RequestParams
) {
  const identity = {
    workspaceId,
    expectedHead: loaded.observedHead,
    expectedBranch: loaded.branch,
    provider: 'github' as const,
    reviewNumber: review.number
  } as const
  if (method === 'github.listAssignableUsers') {
    const result = await client.providerReviewQuery({
      ...identity,
      query: 'assignableUsers'
    })
    if (result.query !== 'assignableUsers') {
      throw new Error('invalid_response')
    }
    return result.users.map((user) => ({ ...user, avatarUrl: '' }))
  }
  const result = await client.providerReviewQuery({
    ...identity,
    query: 'checkDetails',
    checkName: requiredString(params.checkName),
    ...optionalPositiveInteger(params.checkRunId, 'checkRunId'),
    ...optionalPositiveInteger(params.workflowRunId, 'workflowRunId')
  })
  if (result.query !== 'checkDetails') {
    throw new Error('invalid_response')
  }
  return result.details
    ? {
        ...result.details,
        url: null,
        detailsUrl: null,
        text: null,
        annotations: result.details.annotations.map((annotation) => ({
          ...annotation,
          rawDetails: null
        })),
        jobs: result.details.jobs.map((job) => ({
          ...job,
          id: null,
          url: null,
          startedAt: null,
          completedAt: null,
          steps: job.steps.map((step) => ({
            ...step,
            startedAt: null,
            completedAt: null
          }))
        }))
      }
    : null
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('invalid_request')
  }
  return value.trim()
}

function optionalPositiveInteger(
  value: unknown,
  key: 'checkRunId' | 'workflowRunId'
): { checkRunId: number } | { workflowRunId: number } | null {
  if (value === undefined) {
    return null
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('invalid_request')
  }
  return key === 'checkRunId' ? { checkRunId: value } : { workflowRunId: value }
}
