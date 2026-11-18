import type { HostedReviewProvider } from '../../shared/source-control/hosted-review/hosted-review-contracts'
import { readRemoteUrl, withSharedRemoteUrlReads } from '../git/remotes/remote-url-probe'
import { isStableMissingGitRemoteError } from '../git/remotes/stable-missing-git-remote-error'
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
    if (await hasConfirmedMissingOrigin(context)) {
      return null
    }
    for (const provider of FORGE_PROVIDERS) {
      if (await provider.resolveRepository(context)) {
        return provider
      }
    }
    return null
  })
}

/** A repo without an origin has no forge to ask, so no provider CLI or API probe should run. */
async function hasConfirmedMissingOrigin(context: ForgeProviderRepositoryContext): Promise<boolean> {
  const { wslDistro, admissionTier } = getHostedReviewLocalGitOptions(context)
  try {
    await readRemoteUrl(
      {
        repoPath: context.repoPath,
        connectionId: hostedReviewSshConnectionId(context.executionHostId),
        ...(wslDistro ? { wslDistro } : {}),
        ...(admissionTier ? { admissionTier } : {})
      },
      'origin'
    )
    return false
  } catch (error) {
    // Unknown failures stay with the providers, which decide whether to retry or report.
    return isStableMissingGitRemoteError(error)
  }
}

export async function detectHostedReviewProvider(
  context: ForgeProviderRepositoryContext
): Promise<HostedReviewProvider> {
  return (await getForgeProviderForRepository(context))?.id ?? 'unsupported'
}
