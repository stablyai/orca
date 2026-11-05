import type { HostedReviewProvider } from '../../shared/source-control/hosted-review/hosted-review-contracts'
import { withSharedRemoteUrlReads } from '../git/remotes/remote-url-probe'
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
    for (const provider of FORGE_PROVIDERS) {
      if (await provider.resolveRepository(context)) {
        return provider
      }
    }
    return null
  })
}

export async function detectHostedReviewProvider(
  context: ForgeProviderRepositoryContext
): Promise<HostedReviewProvider> {
  return (await getForgeProviderForRepository(context))?.id ?? 'unsupported'
}
