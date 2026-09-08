import type { GitHubWorkItemDetails } from '../../../../shared/github/work-item-types'
import type { GitLabWorkItemDetails } from '../../../../shared/gitlab-types'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { MobileWebProviderReviewProvider } from '../../../../shared/mobile-web/provider-review-contract'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import type { RpcContext } from '../core'

const WORKTREE_SELECTOR_PREFIX = 'id:'

/** A page result minus the workspace handle the page itself owns. Distributes so a discriminated
 *  result keeps its arms. */
export type MobileWebReviewPageResult<T> = T extends unknown ? Omit<T, 'workspaceId'> : never

/** A hosted review the page can render. `unsupported` is the host's own "no provider integration"
 *  marker and has no page projection, so it never reaches a review method. */
export type MobileWebReviewSummary = HostedReviewInfo & {
  provider: MobileWebProviderReviewProvider
}

/** The provider work item behind a summary. Only GitHub and GitLab have a mobile projection, and
 *  a work item that failed to load or answered for another review is `unavailable`. */
export type MobileWebReviewDetails =
  | { state: 'loaded'; provider: 'github'; item: GitHubWorkItemDetails }
  | { state: 'loaded'; provider: 'gitlab'; item: GitLabWorkItemDetails }
  | { state: 'unsupported' }
  | { state: 'unavailable' }

/** The repo half of the worktree id the shell addressed. */
export function mobileWebReviewRepoSelector(worktree: string): string {
  if (!worktree.startsWith(WORKTREE_SELECTOR_PREFIX)) {
    throw new Error('selector_not_found')
  }
  const worktreeId = worktree.slice(WORKTREE_SELECTOR_PREFIX.length)
  return `${WORKTREE_SELECTOR_PREFIX}${getRepoIdFromWorktreeId(worktreeId)}`
}

export type MobileWebReviewIdentity = {
  worktree: string
  expectedHead: string
  expectedBranch: string
}

/** The page's optimistic concurrency check: every review call names the head and branch it was
 *  composed against, and a repository that has moved since fails instead of acting on stale rows. */
export async function assertMobileWebReviewIdentity(
  context: RpcContext,
  identity: MobileWebReviewIdentity
): Promise<void> {
  const status = await context.runtime.getRuntimeGitStatus(identity.worktree)
  if (status.head !== identity.expectedHead || status.branch !== identity.expectedBranch) {
    throw new Error('conflict')
  }
}

export async function readMobileWebReviewSummary(
  context: RpcContext,
  repo: string,
  identity: MobileWebReviewIdentity
): Promise<MobileWebReviewSummary | null> {
  const review = await context.runtime.getHostedReviewForBranch({
    repoSelector: repo,
    branch: identity.expectedBranch,
    currentHeadOid: identity.expectedHead
  })
  if (!review) {
    return null
  }
  if (review.provider === 'unsupported') {
    throw new Error('unsupported_provider')
  }
  return { ...review, provider: review.provider }
}

/** The summary alone carries no body, comments or files; those live behind a provider work-item
 *  read whose failure degrades the review rather than the call. */
export async function readMobileWebReviewDetails(
  context: RpcContext,
  repo: string,
  summary: MobileWebReviewSummary
): Promise<MobileWebReviewDetails> {
  if (summary.provider === 'github') {
    const item = await context.runtime
      .getRepoWorkItemDetails(repo, summary.number, 'pr')
      .catch(() => null)
    return item?.item.number === summary.number && item.item.type === 'pr'
      ? { state: 'loaded', provider: 'github', item }
      : { state: 'unavailable' }
  }
  if (summary.provider === 'gitlab') {
    const item = await context.runtime
      .getGitLabRepoWorkItemDetails(repo, summary.number, 'mr')
      .catch(() => null)
    return item?.item.number === summary.number && item.item.type === 'mr'
      ? { state: 'loaded', provider: 'gitlab', item }
      : { state: 'unavailable' }
  }
  return { state: 'unsupported' }
}

/** Reads the summary and its details for a call that names one review, refusing a repository whose
 *  current review is not the one the page addressed. */
export async function readMobileWebReviewTarget(
  context: RpcContext,
  identity: MobileWebReviewIdentity & {
    provider: MobileWebProviderReviewProvider
    reviewNumber: number
  }
): Promise<{ repo: string; summary: MobileWebReviewSummary; details: MobileWebReviewDetails }> {
  await assertMobileWebReviewIdentity(context, identity)
  const repo = mobileWebReviewRepoSelector(identity.worktree)
  const summary = await readMobileWebReviewSummary(context, repo, identity)
  if (
    !summary ||
    summary.provider !== identity.provider ||
    summary.number !== identity.reviewNumber
  ) {
    throw new Error('conflict')
  }
  return { repo, summary, details: await readMobileWebReviewDetails(context, repo, summary) }
}
