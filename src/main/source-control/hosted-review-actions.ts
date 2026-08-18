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
import { getForgeProviderForRepository, type ForgeProvider } from './forge-provider'
import { getPluginProviderById } from './plugin-forge-provider-bridge'

const NO_ACTIONS: Partial<ForgeProvider> = {}

/**
 * Generic hosted-review action dispatch for forge providers.
 * Plugin providers implement these via ForgeProvider optional methods;
 * built-in providers keep their CLI/REST-specific paths elsewhere.
 */

/**
 * Resolve the plugin provider that owns a repo before dispatching an action,
 * so a stale or crafted provider id cannot invoke a plugin on another forge.
 */
async function resolveActionProvider(
  provider: string,
  repoPath: string,
  connectionId?: string | null
): Promise<Partial<ForgeProvider>> {
  const resolved = await getForgeProviderForRepository({ repoPath, connectionId })
  return resolved && resolved.id === provider ? resolved : NO_ACTIONS
}

export function getHostedReviewActionCapabilities(
  provider: string
): HostedReviewActionCapabilities {
  const actions: Partial<ForgeProvider> = getPluginProviderById(provider) ?? NO_ACTIONS
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
  const actions = await resolveActionProvider(input.provider, input.repoPath, input.connectionId)
  const action = actions.mergeReview
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
  const actions = await resolveActionProvider(input.provider, input.repoPath, input.connectionId)
  const action = actions.commentReview
  if (!action) {
    return { ok: false, code: 'unknown', error: 'Comments are not supported for this provider.' }
  }
  return action(input)
}

export async function approveHostedReview(
  input: ApproveHostedReviewInput
): Promise<ApproveHostedReviewResult> {
  const actions = await resolveActionProvider(input.provider, input.repoPath, input.connectionId)
  const action = actions.approveReview
  if (!action) {
    return { ok: false, code: 'unknown', error: 'Approval is not supported for this provider.' }
  }
  return action(input)
}

export async function listHostedReviewComments(
  input: ListHostedReviewCommentsInput
): Promise<ListHostedReviewCommentsResult> {
  const actions = await resolveActionProvider(input.provider, input.repoPath, input.connectionId)
  const action = actions.listReviewComments
  if (!action) {
    return { ok: false, code: 'unknown', error: 'Comments are not supported for this provider.' }
  }
  return action(input)
}

export async function listHostedReviewIssues(
  input: ListHostedReviewIssuesInput
): Promise<ListHostedReviewIssuesResult> {
  const actions = await resolveActionProvider(input.provider, input.repoPath, input.connectionId)
  const action = actions.listIssues
  if (!action) {
    return { ok: false, code: 'unknown', error: 'Issues are not supported for this provider.' }
  }
  return action(input)
}
