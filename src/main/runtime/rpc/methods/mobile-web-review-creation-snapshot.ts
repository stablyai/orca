import type { RpcContext } from '../core'

/** What the host needs before it can say whether a review can be opened for this branch: the
 *  working tree's cleanliness, its upstream distance, and any review already linked to it. */
export async function readMobileWebReviewCreationSnapshot(context: RpcContext, worktree: string) {
  const [status, upstream, worktreeRow] = await Promise.all([
    context.runtime.getRuntimeGitStatus(worktree),
    context.runtime.getRuntimeGitUpstreamStatus(worktree),
    context.runtime.showManagedWorktree(worktree)
  ])
  if (!worktreeRow) {
    throw new Error('selector_not_found')
  }
  return {
    head: status.head,
    branch: status.branch,
    hasUncommittedChanges: status.entries.length > 0,
    upstream: {
      hasUpstream: upstream.hasUpstream,
      ahead: upstream.ahead,
      behind: upstream.behind
    },
    links: {
      linkedGitHubPR: worktreeRow.linkedPR ?? null,
      linkedGitLabMR: worktreeRow.linkedGitLabMR ?? null,
      linkedBitbucketPR: worktreeRow.linkedBitbucketPR ?? null,
      linkedAzureDevOpsPR: worktreeRow.linkedAzureDevOpsPR ?? null,
      linkedGiteaPR: worktreeRow.linkedGiteaPR ?? null
    }
  }
}
