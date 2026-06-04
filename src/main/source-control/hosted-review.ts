import type { HostedReviewInfo } from '../../shared/hosted-review'
import {
  getForgeProviderById,
  getForgeProviderForRepository,
  type ForgeProviderId
} from './forge-provider'

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

export async function getHostedReviewForBranch(input: {
  repoPath: string
  connectionId?: string | null
  branch: string
  linkedGitHubPR?: number | null
  fallbackGitHubPR?: number | null
  linkedGitLabMR?: number | null
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
}): Promise<HostedReviewInfo | null> {
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
    connectionId: input.connectionId
  })
  if (!provider) {
    return null
  }
  return provider.getReviewForBranch({
    repoPath: input.repoPath,
    connectionId: input.connectionId,
    branch: branchName,
    ...reviewLinkForProvider(input, provider.id)
  })
}

export async function getHostedReviewByNumber(input: {
  repoPath: string
  provider: ForgeProviderId
  number: number
}): Promise<HostedReviewInfo | null> {
  return getForgeProviderById(input.provider).getReviewByNumber(input)
}
