import { deriveHostCacheKey } from './host-cache-key'
import { processGenerationStore } from './process-generation-store'

/** A removed host's recorded update failures go with it. Not gated on the build: a native build
 *  installed over an OTA one inherits its cache, and with no log this only reads a missing file. */
export function forgetHostUpdateFailures(hostId: string): Promise<void> {
  return processGenerationStore().forgetHostUpdateFailures(hostId)
}

/** A removed host's page generations go with it too, so a re-pair never reopens its old tree. */
export function deleteHostPageCache(hostId: string): Promise<void> {
  return processGenerationStore().deleteHostCache(deriveHostCacheKey(hostId))
}
