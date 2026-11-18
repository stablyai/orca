import type { HostedReviewProvider } from '../../shared/source-control/hosted-review/hosted-review-contracts'
import { readRemoteUrl, withSharedRemoteUrlReads } from '../git/remotes/remote-url-probe'
import { isStableMissingGitRemoteError } from '../git/remotes/stable-missing-git-remote-error'
import { parseGitLabProjectRefCandidate } from '../gitlab/projects/project-ref-parser'
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
    const origin = await readOrigin(context)
    // A repo without an origin has no forge to ask, so no provider CLI or API probe should run.
    if (origin === 'missing') {
      return null
    }
    for (const provider of FORGE_PROVIDERS) {
      // The GitLab check asks glab for its signed-in hosts; skip it when origin can't be GitLab.
      if (
        provider.id === 'gitlab' &&
        typeof origin === 'string' &&
        parseGitLabProjectRefCandidate(origin) === null
      ) {
        continue
      }
      if (await provider.resolveRepository(context)) {
        return provider
      }
    }
    return null
  })
}

/** Origin's URL, 'missing' when Git confirms there is none, or 'unknown' (SSH or a failed read). */
async function readOrigin(
  context: ForgeProviderRepositoryContext
): Promise<string | 'missing' | 'unknown'> {
  const { wslDistro, admissionTier } = getHostedReviewLocalGitOptions(context)
  try {
    const url = await readRemoteUrl(
      {
        repoPath: context.repoPath,
        connectionId: hostedReviewSshConnectionId(context.executionHostId),
        ...(wslDistro ? { wslDistro } : {}),
        ...(admissionTier ? { admissionTier } : {})
      },
      'origin'
    )
    return url ?? 'unknown'
  } catch (error) {
    // Unknown failures stay with the providers, which decide whether to retry or report.
    return isStableMissingGitRemoteError(error) ? 'missing' : 'unknown'
  }
}

export async function detectHostedReviewProvider(
  context: ForgeProviderRepositoryContext
): Promise<HostedReviewProvider> {
  return (await getForgeProviderForRepository(context))?.id ?? 'unsupported'
}
