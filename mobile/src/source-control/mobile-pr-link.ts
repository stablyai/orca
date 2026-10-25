import type { RpcSendParams } from '../transport/rpc-params-contract'
import { refusedRpcMessageOrFallback } from '../transport/rpc-refusal-message'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import { worktreeLinkSet, worktreeSummaryRead } from './mobile-worktree-metadata-operations'

// Use the desktop worktree metadata fields so follow-up reads share authoritative review hints.

export type MobilePrLinkOutcome = { ok: true } | { ok: false; error: string }

export function buildWorktreeSetLinkParams(
  worktreeId: string,
  linkedPR: number | null
): RpcSendParams<'worktree.set'> {
  return { worktree: `id:${worktreeId}`, linkedPR }
}

export function buildWorktreeSetHostedReviewLinkParams(
  worktreeId: string,
  provider: string,
  number: number | null,
  options?: { baseRef?: string | null }
): RpcSendParams<'worktree.set'> {
  const trimmedBaseRef = options?.baseRef?.trim()
  const base = {
    worktree: `id:${worktreeId}`,
    ...(trimmedBaseRef ? { baseRef: trimmedBaseRef } : {})
  }
  switch (provider) {
    case 'github':
      return { ...base, linkedPR: number }
    case 'gitlab':
      return { ...base, linkedGitLabMR: number }
    case 'bitbucket':
      return { ...base, linkedBitbucketPR: number }
    case 'azure-devops':
      return { ...base, linkedAzureDevOpsPR: number }
    case 'gitea':
      return { ...base, linkedGiteaPR: number }
    default:
      return base
  }
}

// Refusal without a message uses screen copy; transport errors retain their own message.
async function setWorktreeReviewLink(
  client: RpcOperationSender,
  params: RpcSendParams<'worktree.set'>,
  fallback: string
): Promise<MobilePrLinkOutcome> {
  let reply
  try {
    reply = await worktreeLinkSet.request(client, params)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : fallback }
  }
  try {
    worktreeLinkSet.interpret(reply)
  } catch (error) {
    return { ok: false, error: refusedRpcMessageOrFallback(error, fallback) }
  }
  return { ok: true }
}

export function linkMobilePr(
  client: RpcOperationSender,
  worktreeId: string,
  prNumber: number
): Promise<MobilePrLinkOutcome> {
  return setWorktreeReviewLink(
    client,
    buildWorktreeSetLinkParams(worktreeId, prNumber),
    'Failed to update linked pull request'
  )
}

export async function linkMobileHostedReview(
  client: RpcOperationSender,
  worktreeId: string,
  provider: string,
  number: number,
  options?: { baseRef?: string | null }
): Promise<MobilePrLinkOutcome> {
  const params = buildWorktreeSetHostedReviewLinkParams(worktreeId, provider, number, options)
  if (Object.keys(params).length === 1) {
    return { ok: true }
  }
  // Link refresh failure is nonfatal: the review already exists, so keep its URL.
  return setWorktreeReviewLink(client, params, 'Failed to update linked review')
}

export function unlinkMobilePr(
  client: RpcOperationSender,
  worktreeId: string
): Promise<MobilePrLinkOutcome> {
  return setWorktreeReviewLink(
    client,
    buildWorktreeSetLinkParams(worktreeId, null),
    'Failed to update linked pull request'
  )
}

// Persisted links recover closed/merged PRs that branch lookup no longer returns.
export async function fetchWorktreeLinkedPR(
  client: RpcOperationSender,
  worktreeId: string
): Promise<number | null> {
  try {
    const reply = await worktreeSummaryRead.request(client, { worktree: `id:${worktreeId}` })
    const summary = worktreeSummaryRead.interpret(reply)
    return summary.accepted ? (summary.value?.linkedPR ?? null) : null
  } catch {
    // A failed fallback read is a missing hint, not a fatal error.
    return null
  }
}
