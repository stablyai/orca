import type { HostedReviewInfo } from '../../shared/hosted-review'
import { getForgeProviderForRepository, type ForgeProviderId } from './forge-provider'
import { withHostedReviewBranchCache } from './hosted-review-branch-cache'
import type { HostedReviewExecutionOptions } from './hosted-review-git-options'

function reviewLinkForProvider(
  input: Parameters<typeof getHostedReviewForBranch>[0],
  provider: ForgeProviderId
): { linkedReviewNumber?: number | null; fallbackReviewNumber?: number | null } {
  switch (provider) {
    case 'github':
      return {
        linkedReviewNumber: input.linkedGitHubPR ?? null,
        fallbackReviewNumber: input.linkedGitHubPR == null ? (input.fallbackGitHubPR ?? null) : null
      }
    case 'gitlab':
      return { linkedReviewNumber: input.linkedGitLabMR ?? null }
    case 'bitbucket':
      return { linkedReviewNumber: input.linkedBitbucketPR ?? null }
    case 'azure-devops':
      return { linkedReviewNumber: input.linkedAzureDevOpsPR ?? null }
    case 'gitea':
      return { linkedReviewNumber: input.linkedGiteaPR ?? null }
  }
}

export async function getHostedReviewForBranch(
  input: {
    repoPath: string
    connectionId?: string | null
    branch: string
    linkedGitHubPR?: number | null
    fallbackGitHubPR?: number | null
    linkedGitLabMR?: number | null
    linkedBitbucketPR?: number | null
    linkedAzureDevOpsPR?: number | null
    linkedGiteaPR?: number | null
    currentHeadOid?: string | null
    /**
     * Set by surfaces that only ever render the selected worktree, which is the
     * one branch cheap enough to re-check per minute (#11532).
     */
    active?: boolean
  } & HostedReviewExecutionOptions
): Promise<HostedReviewInfo | null> {
  const branchName = input.branch.replace(/^refs\/heads\//, '')
  // Why: detached HEAD cannot use branch lookup, but provider-specific exact
  // ids can still resolve the review without probing an empty branch name.
  if (
    !branchName &&
    input.linkedGitHubPR == null &&
    input.fallbackGitHubPR == null &&
    input.linkedGitLabMR == null &&
    input.linkedBitbucketPR == null &&
    input.linkedAzureDevOpsPR == null &&
    input.linkedGiteaPR == null
  ) {
    return null
  }

  const headOid = input.currentHeadOid?.trim() || null
  // Why (#11532): every client polls this one entry point, and they share the
  // host's per-user API quota, so the cache has to sit above the provider call.
  return withHostedReviewBranchCache(
    { ...input, branch: branchName },
    { headOid, ...(input.active === true ? { active: true } : {}) },
    async () => {
      const provider = await getForgeProviderForRepository({
        repoPath: input.repoPath,
        connectionId: input.connectionId,
        ...(input.localGitExecOptions ? { localGitExecOptions: input.localGitExecOptions } : {})
      })
      if (!provider) {
        return null
      }
      return provider.getReviewForBranch({
        repoPath: input.repoPath,
        connectionId: input.connectionId,
        branch: branchName,
        ...(input.localGitExecOptions ? { localGitExecOptions: input.localGitExecOptions } : {}),
        githubCurrentHeadOid: headOid,
        ...reviewLinkForProvider(input, provider.id)
      })
    }
  )
}
