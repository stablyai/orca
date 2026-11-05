import { deriveHostCacheKey } from './host-cache-key'
import { processGenerationStore } from './process-generation-store'
import { evictRetainedShellSessionForHost } from './retained-shell-session-store'

export function forgetHostUpdateFailures(hostId: string): Promise<void> {
  return processGenerationStore().forgetHostUpdateFailures(hostId)
}

// Remove generations with the host so re-pair cannot reopen its previous cache.
export function deleteHostPageCache(hostId: string): Promise<void> {
  evictRetainedShellSessionForHost(hostId)
  return processGenerationStore().deleteHostCache(deriveHostCacheKey(hostId))
}
