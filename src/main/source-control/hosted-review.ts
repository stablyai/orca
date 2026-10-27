import type { ExecutionHostId } from '../../shared/execution-host'
import type { HostedReviewInfo } from '../../shared/hosted-review'
import { assertRemoteUrlReadable } from '../git/remote-url-probe'
import { getForgeProviderForRepository, type ForgeProviderId } from './forge-provider'
import { hostedReviewSshConnectionId } from './hosted-review-execution-host'
import { withHostedReviewBranchCache } from './hosted-review-branch-cache'
import {
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from './hosted-review-git-options'

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
    executionHostId: ExecutionHostId
    branch: string
    linkedGitHubPR?: number | null
    fallbackGitHubPR?: number | null
    linkedGitLabMR?: number | null
    linkedBitbucketPR?: number | null
    linkedAzureDevOpsPR?: number | null
    linkedGiteaPR?: number | null
    currentHeadOid?: string | null
    /** Selected-worktree surfaces earn per-minute pacing (#11532). */
    active?: boolean
    force?: boolean
  } & HostedReviewExecutionOptions
): Promise<HostedReviewInfo | null> {
  const branchName = input.branch.replace(/^refs\/heads\//, '')
  // Detached HEAD skips branch lookup but still permits exact provider ids.
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
  // All clients spend one host-user API quota; cache above the provider funnel (#11532).
  return withHostedReviewBranchCache(
    { ...input, branch: branchName },
    {
      headOid,
      ...(input.active === true ? { active: true } : {}),
      ...(input.force === true ? { force: true } : {})
    },
    async () => {
      const provider = await getForgeProviderForRepository({
        repoPath: input.repoPath,
        executionHostId: input.executionHostId,
        ...(input.localGitExecOptions ? { localGitExecOptions: input.localGitExecOptions } : {})
      })
      if (!provider) {
        // Detection swallows errors; probe reachability first so timeouts/relay loss cannot cache definitive no-review (P1-D).
        await assertRemoteUrlReadable({
          repoPath: input.repoPath,
          // The probe is the leaf that still dials: it takes the SSH target, not the host id.
          connectionId: hostedReviewSshConnectionId(input.executionHostId),
          ...getHostedReviewLocalGitOptions(input)
        })
        return null
      }
      return provider.getReviewForBranch({
        repoPath: input.repoPath,
        executionHostId: input.executionHostId,
        branch: branchName,
        ...(input.localGitExecOptions ? { localGitExecOptions: input.localGitExecOptions } : {}),
        githubCurrentHeadOid: headOid,
        ...reviewLinkForProvider(input, provider.id)
      })
    }
  )
}
