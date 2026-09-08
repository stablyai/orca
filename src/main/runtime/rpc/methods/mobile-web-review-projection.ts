import { MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES } from '../../../../shared/mobile-web/bridge-limits'
import type { PRCheckDetail } from '../../../../shared/github/check-types'
import type {
  GitHubAssignableUser,
  GitHubPRReviewSummary
} from '../../../../shared/github/pull-request-types'
import {
  MOBILE_WEB_PROVIDER_REVIEW_BODY_MAX_CHARACTERS,
  MOBILE_WEB_PROVIDER_REVIEW_CHECK_LIMIT,
  MOBILE_WEB_PROVIDER_REVIEW_USER_LIMIT,
  MobileWebProviderReviewSchema,
  type MobileWebProviderReview
} from '../../../../shared/mobile-web/provider-review-contract'
import { projectMobileWebReviewComments } from './mobile-web-review-comment-projection'
import { projectMobileWebReviewFiles } from './mobile-web-review-file-projection'
import type { MobileWebReviewDetails, MobileWebReviewSummary } from './mobile-web-review-scope'

/** Maps the host's own review types onto the page contract. The only work is renaming fields,
 *  splitting the two providers, and clipping the lists and free text the provider does not bound. */
export function projectMobileWebReview(
  summary: MobileWebReviewSummary,
  details: MobileWebReviewDetails
): MobileWebProviderReview {
  const base = {
    provider: summary.provider,
    number: summary.number,
    title: summary.title.slice(0, 512),
    state: summary.state,
    checksStatus: summary.status,
    mergeable: summary.mergeable,
    reviewDecision: summary.reviewDecision ?? null,
    ...(summary.autoMergeEnabled === undefined
      ? {}
      : { autoMergeEnabled: summary.autoMergeEnabled }),
    ...(summary.autoMergeAllowed === undefined
      ? {}
      : { autoMergeAllowed: summary.autoMergeAllowed }),
    ...(summary.mergeStateStatus === undefined
      ? {}
      : { mergeStateStatus: summary.mergeStateStatus?.slice(0, 80) ?? null }),
    updatedAt: summary.updatedAt.slice(0, 64)
  }
  if (details.state !== 'loaded') {
    return MobileWebProviderReviewSchema.parse({
      ...base,
      ...(summary.headSha ? { headSha: summary.headSha } : {}),
      body: '',
      comments: [],
      commentsTruncated: false,
      files: [],
      filesTruncated: false,
      author: null,
      detailsState: details.state,
      canComment: false
    })
  }
  const headSha = details.item.headSha ?? summary.headSha
  const comments = projectMobileWebReviewComments(details.provider, details.item.comments)
  const files = projectMobileWebReviewFiles(details)
  const participants = details.provider === 'github' ? details.item.item : null
  const review = MobileWebProviderReviewSchema.parse({
    ...base,
    ...(headSha ? { headSha } : {}),
    body: details.item.body.slice(0, MOBILE_WEB_PROVIDER_REVIEW_BODY_MAX_CHARACTERS),
    comments: comments.items,
    commentsTruncated: comments.truncated,
    files: files.items,
    filesTruncated: files.truncated,
    author: details.item.item.author?.slice(0, 80) ?? null,
    reviewRequests: projectReviewUsers(participants?.reviewRequests),
    latestReviews: projectLatestReviews(participants?.latestReviews),
    checks: projectChecks(details.provider === 'github' ? details.item.checks : undefined),
    detailsState: 'loaded',
    canComment: true,
    allowedSubmissionActions: submissionActions(summary, headSha)
  })
  review.comments = []
  review.files = []
  // Reserve room for the response identity; JSON escaping counts toward the shell's byte envelope.
  let remaining =
    MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES - 8192 - Buffer.byteLength(JSON.stringify(review))
  for (const file of files.items) {
    const bytes = Buffer.byteLength(JSON.stringify(file)) + 1
    if (bytes > remaining) {
      break
    }
    remaining -= bytes
    review.files.push(file)
  }
  for (const comment of comments.items.toReversed()) {
    const bytes = Buffer.byteLength(JSON.stringify(comment)) + 1
    if (bytes > remaining) {
      break
    }
    remaining -= bytes
    review.comments.unshift(comment)
  }
  review.filesTruncated ||= review.files.length < files.items.length
  review.commentsTruncated ||= review.comments.length < comments.items.length
  return review
}

/** A review only accepts a verdict while it is still open, and only against a known head. */
function submissionActions(
  summary: MobileWebReviewSummary,
  headSha: string | undefined
): MobileWebProviderReview['allowedSubmissionActions'] {
  if ((summary.state !== 'open' && summary.state !== 'draft') || !headSha) {
    return []
  }
  if (summary.provider === 'github') {
    return ['comment', 'approve', 'request-changes']
  }
  return summary.provider === 'gitlab' ? ['comment'] : []
}

function projectReviewUsers(
  users: readonly GitHubAssignableUser[] | undefined
): MobileWebProviderReview['reviewRequests'] {
  return (users ?? [])
    .slice(0, MOBILE_WEB_PROVIDER_REVIEW_USER_LIMIT)
    .map((user) => ({ login: user.login.slice(0, 80), name: user.name?.slice(0, 160) ?? null }))
}

function projectLatestReviews(
  reviews: readonly GitHubPRReviewSummary[] | undefined
): MobileWebProviderReview['latestReviews'] {
  return (reviews ?? []).slice(0, MOBILE_WEB_PROVIDER_REVIEW_USER_LIMIT).map((review) => ({
    login: review.login.slice(0, 80),
    state: review.state?.slice(0, 80) ?? null
  }))
}

function projectChecks(
  checks: readonly PRCheckDetail[] | undefined
): MobileWebProviderReview['checks'] {
  return (checks ?? []).slice(0, MOBILE_WEB_PROVIDER_REVIEW_CHECK_LIMIT).map((check) => ({
    name: check.name.slice(0, 256),
    status: check.status,
    conclusion: check.conclusion,
    ...(check.checkRunId === undefined ? {} : { checkRunId: check.checkRunId }),
    ...(check.workflowRunId === undefined ? {} : { workflowRunId: check.workflowRunId })
  }))
}
