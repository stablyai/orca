import type { HostedReviewInfo } from '../../shared/hosted-review'
import { getForgeProviderForRepository, type ForgeProviderId } from './forge-provider'
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
    githubCurrentHeadOid: input.currentHeadOid ?? null,
    ...reviewLinkForProvider(input, provider.id)
  })
}
