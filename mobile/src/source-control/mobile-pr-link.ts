import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import type { HostedReviewProvider } from '../../../src/shared/hosted-review'

// Link / unlink review metadata via worktree.set (the same path desktop uses).
// GitHub's existing manual link flow writes linkedPR; hosted-review creation maps
// each provider to its own linked* field so mobile follow-up reads get the same
// authoritative hint as desktop.

export type MobilePrLinkOutcome = { ok: true } | { ok: false; error: string }

// Pure param builder (unit-tested): the worktree selector + tri-state linkedPR.
export function buildWorktreeSetLinkParams(
  worktreeId: string,
  linkedPR: number | null
): Record<string, unknown> {
  return { worktree: `id:${worktreeId}`, linkedPR }
}

export function buildWorktreeSetHostedReviewLinkParams(
  worktreeId: string,
  provider: HostedReviewProvider,
  number: number | null,
  options?: { baseRef?: string | null }
): Record<string, unknown> {
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
    case 'unsupported':
      return base
  }
}

async function setLinkedPr(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  linkedPR: number | null
): Promise<MobilePrLinkOutcome> {
  try {
    const response = await client.sendRequest(
      'worktree.set',
      buildWorktreeSetLinkParams(worktreeId, linkedPR)
    )
    if (!response.ok) {
      return { ok: false, error: response.error?.message || 'Failed to update linked pull request' }
    }
    return { ok: true }
  } catch (err) {
    // Why: a transport drop must not escape as an unhandled rejection — normalize
    // to the `{ ok:false, error }` outcome the link flow surfaces.
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to update linked pull request'
    }
  }
}

export function linkMobilePr(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  prNumber: number
): Promise<MobilePrLinkOutcome> {
  return setLinkedPr(client, worktreeId, prNumber)
}

export async function linkMobileHostedReview(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  provider: HostedReviewProvider,
  number: number,
  options?: { baseRef?: string | null }
): Promise<MobilePrLinkOutcome> {
  const params = buildWorktreeSetHostedReviewLinkParams(worktreeId, provider, number, options)
  if (Object.keys(params).length === 1) {
    return { ok: true }
  }
  try {
    const response = await client.sendRequest('worktree.set', params)
    if (!response.ok) {
      return { ok: false, error: response.error?.message || 'Failed to update linked review' }
    }
    return { ok: true }
  } catch (err) {
    // Why: the review was already created; normalize link failures so callers can
    // surface a non-fatal refresh problem instead of losing the created URL.
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to update linked review'
    }
  }
}

export function unlinkMobilePr(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string
): Promise<MobilePrLinkOutcome> {
  return setLinkedPr(client, worktreeId, null)
}

// Reads the worktree's persisted linkedPR (via worktree.show) so the sidebar can
// surface a linked PR even when it's closed/merged and the branch-based lookup
// returns nothing. Returns null when unset or on any read failure.
export async function fetchWorktreeLinkedPR(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string
): Promise<number | null> {
  try {
    const response = await client.sendRequest('worktree.show', { worktree: `id:${worktreeId}` })
    if (!response.ok) {
      return null
    }
    const result = (response as RpcSuccess).result as { worktree?: { linkedPR?: number | null } }
    const linked = result?.worktree?.linkedPR
    return typeof linked === 'number' ? linked : null
  } catch {
    // Why: a fallback read — a transport drop is non-fatal, fall back to "no link".
    return null
  }
}
