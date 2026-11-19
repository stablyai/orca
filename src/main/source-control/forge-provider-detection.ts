import type { HostedReviewProvider } from '../../shared/source-control/hosted-review/hosted-review-contracts'
import { isRemoteKnownMissing, withSharedRemoteUrlReads } from '../git/remotes/remote-url-probe'
import { hostedReviewSshConnectionId } from './hosted-review-execution-host'
import { getHostedReviewLocalGitOptions } from './hosted-review-git-options'
import {
  FORGE_PROVIDERS,
  type ForgeProvider,
  type ForgeProviderRepositoryContext
} from './forge-provider'

/** First provider, in precedence order, that recognizes the repository's remote. */
export async function getForgeProviderForRepository(
  context: ForgeProviderRepositoryContext
): Promise<ForgeProvider | null> {
  // Every provider probes the same remote; one detection pass reads it once.
  return withSharedRemoteUrlReads(async () => {
    // GitLab only resolves origin, and its check starts by asking glab for signed-in hosts.
    const skipGitLab = await isOriginKnownMissing(context)
    for (const provider of FORGE_PROVIDERS) {
      if (provider.id === 'gitlab' && skipGitLab) {
        continue
      }
      if (await provider.resolveRepository(context)) {
        return provider
      }
    }
    return null
  })
}

function isOriginKnownMissing(context: ForgeProviderRepositoryContext): Promise<boolean> {
  const { wslDistro, admissionTier } = getHostedReviewLocalGitOptions(context)
  return isRemoteKnownMissing(
    {
      repoPath: context.repoPath,
      connectionId: hostedReviewSshConnectionId(context.executionHostId),
      ...(wslDistro ? { wslDistro } : {}),
      ...(admissionTier ? { admissionTier } : {})
    },
    'origin'
  )
}

export async function detectHostedReviewProvider(
  context: ForgeProviderRepositoryContext
): Promise<HostedReviewProvider> {
  return (await getForgeProviderForRepository(context))?.id ?? 'unsupported'
}
