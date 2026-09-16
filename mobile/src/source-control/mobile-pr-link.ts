import type { RpcSendParams } from '../transport/rpc-params-contract'
import { refusedRpcMessageOrFallback } from '../transport/rpc-refusal-message'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import { worktreeLinkSet, worktreeSummaryRead } from './mobile-worktree-metadata-operations'

// Link / unlink review metadata via worktree.set (the same path desktop uses).
// GitHub's existing manual link flow writes linkedPR; hosted-review creation maps
// each provider to its own linked* field so mobile follow-up reads get the same
// authoritative hint as desktop.

export type MobilePrLinkOutcome = { ok: true } | { ok: false; error: string }

// Pure param builder (unit-tested): the worktree selector + tri-state linkedPR.
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
    // 'unsupported', and any token this build does not know: no linked* field to write.
    default:
      return base
  }
}

/**
 * Two catches, because main had two paths: a refusal falls back to the screen's copy when the
 * host sent no message, while a transport drop surfaces its own message verbatim.
 */
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
  // Why a distinct fallback: the review already exists, so callers surface this as a non-fatal
  // refresh problem rather than losing the created URL.
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

// Reads the worktree's persisted linkedPR so the sidebar can surface a linked PR even when it's
// closed/merged and the branch-based lookup returns nothing. Null when unset or on any failure.
export async function fetchWorktreeLinkedPR(
  client: RpcOperationSender,
  worktreeId: string
): Promise<number | null> {
  try {
    const reply = await worktreeSummaryRead.request(client, { worktree: `id:${worktreeId}` })
    const summary = worktreeSummaryRead.interpret(reply)
    return summary.accepted ? (summary.value?.linkedPR ?? null) : null
  } catch {
    // Why: a fallback read — a transport drop is non-fatal, fall back to "no link".
    return null
  }
}
