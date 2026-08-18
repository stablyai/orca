import type {
  ApproveHostedReviewInput,
  ApproveHostedReviewResult,
  CommentHostedReviewInput,
  CommentHostedReviewResult,
  HostedReviewActionCapabilities,
  ListHostedReviewCommentsInput,
  ListHostedReviewCommentsResult,
  ListHostedReviewIssuesInput,
  ListHostedReviewIssuesResult,
  MergeHostedReviewInput,
  MergeHostedReviewResult
} from '../../shared/hosted-review-actions'
import { getPluginProviderById } from './plugin-forge-provider-bridge'

/**
 * Generic hosted-review action dispatch for forge providers.
 * Plugin providers implement these via ForgeProvider optional methods;
 * built-in providers keep their CLI/REST-specific paths elsewhere.
 */

function resolveActionProvider(provider: string): {
  mergeReview?: (input: MergeHostedReviewInput) => Promise<MergeHostedReviewResult>
  commentReview?: (input: CommentHostedReviewInput) => Promise<CommentHostedReviewResult>
  approveReview?: (input: ApproveHostedReviewInput) => Promise<ApproveHostedReviewResult>
  listReviewComments?: (
    input: ListHostedReviewCommentsInput
  ) => Promise<ListHostedReviewCommentsResult>
  listIssues?: (input: ListHostedReviewIssuesInput) => Promise<ListHostedReviewIssuesResult>
} {
  return getPluginProviderById(provider) ?? {}
}

export function getHostedReviewActionCapabilities(
  provider: string
): HostedReviewActionCapabilities {
  const actions = resolveActionProvider(provider)
  return {
    canMerge: typeof actions.mergeReview === 'function',
    canComment: typeof actions.commentReview === 'function',
    canApprove: typeof actions.approveReview === 'function',
    canListIssues: typeof actions.listIssues === 'function'
  }
}

export async function mergeHostedReview(
  input: MergeHostedReviewInput
): Promise<MergeHostedReviewResult> {
  const action = resolveActionProvider(input.provider).mergeReview
  if (!action) {
    return {
      ok: false,
      code: 'unknown',
      error: 'Merging reviews is not supported for this provider.'
    }
  }
  return action(input)
}

export async function commentOnHostedReview(
  input: CommentHostedReviewInput
): Promise<CommentHostedReviewResult> {
  const action = resolveActionProvider(input.provider).commentReview
  if (!action) {
    return { ok: false, code: 'unknown', error: 'Comments are not supported for this provider.' }
  }
  return action(input)
}

export async function approveHostedReview(
  input: ApproveHostedReviewInput
): Promise<ApproveHostedReviewResult> {
  const action = resolveActionProvider(input.provider).approveReview
  if (!action) {
    return { ok: false, code: 'unknown', error: 'Approval is not supported for this provider.' }
  }
  return action(input)
}

export async function listHostedReviewComments(
  input: ListHostedReviewCommentsInput
): Promise<ListHostedReviewCommentsResult> {
  const action = resolveActionProvider(input.provider).listReviewComments
  if (!action) {
    return { ok: false, code: 'unknown', error: 'Comments are not supported for this provider.' }
  }
  return action(input)
}

export async function listHostedReviewIssues(
  input: ListHostedReviewIssuesInput
): Promise<ListHostedReviewIssuesResult> {
  const action = resolveActionProvider(input.provider).listIssues
  if (!action) {
    return { ok: false, code: 'unknown', error: 'Issues are not supported for this provider.' }
  }
  return action(input)
}
