export type RepoIdentityNotificationChannel = 'desktop' | 'runtime'
export type RepoIdentityEnrichmentRequest = { probeRuntimeHostPaths: boolean }
export type RepoIdentityNotificationRegistry = Map<
  'default' | RepoIdentityNotificationChannel,
  () => void
>
export type RepoIdentityBackgroundTask = {
  generation: number
  promise: Promise<void>
  pendingRequest: RepoIdentityEnrichmentRequest | null
  onChangedByChannel: RepoIdentityNotificationRegistry
}

export function enrichmentRequest(probeRuntimeHostPaths: boolean): RepoIdentityEnrichmentRequest {
  return { probeRuntimeHostPaths }
}

export function mergePendingEnrichmentRequest(
  pending: RepoIdentityEnrichmentRequest | null,
  probeRuntimeHostPaths: boolean
): RepoIdentityEnrichmentRequest {
  return {
    // Why: authority added while a pass is active applies only to its queued
    // rerun; the active pass keeps the immutable request it started with.
    probeRuntimeHostPaths: (pending?.probeRuntimeHostPaths ?? false) || probeRuntimeHostPaths
  }
}

export function rememberRepoIdentityNotification(
  registry: RepoIdentityNotificationRegistry,
  channel: RepoIdentityNotificationChannel | undefined,
  onChanged: (() => void) | undefined
): void {
  if (onChanged) {
    registry.set(channel ?? 'default', onChanged)
  }
}

export function notifyRepoIdentityConsumers(registry: RepoIdentityNotificationRegistry): void {
  for (const [channel, onChanged] of registry) {
    try {
      onChanged()
    } catch (error: unknown) {
      // Why: one consumer's notification failure must not suppress the other
      // semantic channel after the shared enrichment already persisted data.
      console.error(`[repo-identity] Failed to notify ${channel} consumer:`, error)
    }
  }
}
