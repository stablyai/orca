import type { SshGitProvider } from './ssh-git-provider'
import { scheduleSshProviderMissRecovery } from './ssh-provider-miss-recovery'

const sshProviders = new Map<string, SshGitProvider>()
const sshProviderGenerations = new Map<string, number>()
const SSH_PROVIDER_GENERATION_MAX_ENTRIES = 512
let providerGenerationSequence = 0
let evictedProviderGeneration = 0

export const SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE =
  'Remote connection dropped. Click Reconnect on the SSH target before retrying.'

export function registerSshGitProvider(connectionId: string, provider: SshGitProvider): void {
  sshProviders.set(connectionId, provider)
  sshProviderGenerations.set(connectionId, ++providerGenerationSequence)
  pruneProviderGenerations()
}

export function unregisterSshGitProvider(connectionId: string): void {
  if (sshProviders.delete(connectionId)) {
    sshProviderGenerations.set(connectionId, ++providerGenerationSequence)
    pruneProviderGenerations()
  }
}

// Connection ids are externally supplied and can churn across repeated SSH
// sessions. Keep recent generations for cache invalidation without retaining
// every retired target for the lifetime of the main process.
function pruneProviderGenerations(): void {
  while (sshProviderGenerations.size > SSH_PROVIDER_GENERATION_MAX_ENTRIES) {
    const oldest = sshProviderGenerations.keys().next()
    if (oldest.done) {
      return
    }
    evictedProviderGeneration = Math.max(
      evictedProviderGeneration,
      sshProviderGenerations.get(oldest.value) ?? 0
    )
    sshProviderGenerations.delete(oldest.value)
  }
}

export function getSshGitProviderGeneration(connectionId: string): number {
  return sshProviderGenerations.get(connectionId) ?? evictedProviderGeneration
}

/** @internal - exposed for cache-bound regression tests. */
export function _getSshGitProviderGenerationCacheSize(): number {
  return sshProviderGenerations.size
}

export function getSshGitProvider(connectionId: string): SshGitProvider | undefined {
  return sshProviders.get(connectionId)
}

export function requireSshGitProvider(connectionId: string): SshGitProvider {
  const provider = getSshGitProvider(connectionId)
  if (!provider) {
    // Why: a runtime-owned relay has no host-list Reconnect; its owner re-attaches it in the
    // background so the caller's next retry finds the provider. This call still fails.
    scheduleSshProviderMissRecovery(connectionId)
    throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
  }
  return provider
}
