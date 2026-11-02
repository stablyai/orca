import { deriveHostCacheKey } from './host-cache-key'
import { processGenerationStore } from './process-generation-store'

export function forgetHostUpdateFailures(hostId: string): Promise<void> {
  return processGenerationStore().forgetHostUpdateFailures(hostId)
}

// Remove generations with the host so re-pair cannot reopen its previous cache.
export function deleteHostPageCache(hostId: string): Promise<void> {
  return processGenerationStore().deleteHostCache(deriveHostCacheKey(hostId))
}
