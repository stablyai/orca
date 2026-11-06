import { translate } from '../i18n/mobile-i18n'
import type { RpcSendParams } from '../transport/rpc-params-contract'
import { CLEARED_HOSTED_REVIEW_SELECTION_UPDATES } from '../../../src/shared/worktree/hosted-review-links'
import { refusedRpcMessageOrFallback } from '../transport/rpc-refusal-message'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import {
  worktreeLinkSet,
  worktreeSummaryRead,
  type MobileWorktreeSummary
} from './mobile-worktree-metadata-operations'

// Use the desktop worktree metadata fields so follow-up reads share authoritative review hints.

export type MobilePrLinkOutcome = { ok: true } | { ok: false; error: string }

function buildWorktreeSetLinkParams(
  worktreeId: string,
  linkedPR: number | null
): RpcSendParams<'worktree.set'> {
  return { worktree: `id:${worktreeId}`, linkedPR }
}

export type WorktreeGitHubPRLink = Pick<
  MobileWorktreeSummary,
  'linkedPR' | 'suppressedGitHubPR' | 'pushTarget'
>

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
    translate(
      'sourceControl.prLink.updatePullRequestFailed',
      'Failed to update linked pull request'
    )
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
  return setWorktreeReviewLink(
    client,
    params,
    translate('sourceControl.prLink.updateReviewFailed', 'Failed to update linked review')
  )
}

// Like desktop, suppress the unlinked PR so branch discovery does not bring it straight back.
export function unlinkMobilePr(
  client: RpcOperationSender,
  worktreeId: string,
  prNumber: number
): Promise<MobilePrLinkOutcome> {
  return setWorktreeReviewLink(
    client,
    { ...buildWorktreeSetLinkParams(worktreeId, null), suppressedGitHubPR: prNumber },
    translate(
      'sourceControl.prLink.updatePullRequestFailed',
      'Failed to update linked pull request'
    )
  )
}

const NO_GITHUB_PR_LINK: WorktreeGitHubPRLink = {
  linkedPR: null,
  suppressedGitHubPR: null,
  pushTarget: null
}

// Desktop's durable clear for a link the branch has moved past; a failed write only repeats the check next load.
export async function clearMobileWorktreeReviewLink(
  client: RpcOperationSender,
  worktreeId: string,
  shouldApply: (worktree: MobileWorktreeSummary) => boolean
): Promise<void> {
  // Like desktop, re-read the worktree so a link chosen after the lookup is never cleared.
  const current = await readWorktreeSummary(client, worktreeId)
  if (!current || !shouldApply(current)) {
    return
  }
  await setWorktreeReviewLink(
    client,
    { worktree: `id:${worktreeId}`, ...CLEARED_HOSTED_REVIEW_SELECTION_UPDATES },
    translate(
      'sourceControl.prLink.updatePullRequestFailed',
      'Failed to update linked pull request'
    )
  )
}

// Persisted links recover closed/merged PRs that branch lookup no longer returns.
export async function fetchWorktreeGitHubPRLink(
  client: RpcOperationSender,
  worktreeId: string
): Promise<WorktreeGitHubPRLink> {
  return (await readWorktreeSummary(client, worktreeId)) ?? NO_GITHUB_PR_LINK
}

async function readWorktreeSummary(
  client: RpcOperationSender,
  worktreeId: string
): Promise<MobileWorktreeSummary | null> {
  try {
    const reply = await worktreeSummaryRead.request(client, { worktree: `id:${worktreeId}` })
    const summary = worktreeSummaryRead.interpret(reply)
    return summary.accepted ? summary.value : null
  } catch {
    // A failed fallback read is a missing hint, not a fatal error.
    return null
  }
}
