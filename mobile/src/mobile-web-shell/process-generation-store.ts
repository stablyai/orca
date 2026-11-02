import { readStoredHostProfilesForMutation } from '../transport/host-metadata-store'
import { createGenerationStore, type GenerationStore } from './generation-store'
import { createExpoGenerationFileSystem } from './generation-store-file-system'
import { deriveHostCacheKey } from './host-cache-key'

let processStore: GenerationStore | null = null

// Reject on an unreadable list so a storage fault never reads as "nothing paired"; bypass the mutation queue so keychain stalls cannot block the store.
async function readPairedHostKeys(): Promise<ReadonlySet<string>> {
  const hosts = await readStoredHostProfilesForMutation()
  if (hosts.length === 0) {
    // Storage that reads back nothing looks the same; removal's own delete already covers the last host.
    throw new Error('no paired hosts to keep')
  }
  return new Set(hosts.map(({ id }) => deriveHostCacheKey(id)))
}

// Share one store queue across native callers so host removal cannot interleave with generation/failure-log writes.
export function processGenerationStore(): GenerationStore {
  if (processStore === null) {
    processStore = createGenerationStore({ fileSystem: createExpoGenerationFileSystem() })
    // Queued first, once per launch: reclaims hosts whose removal-time delete never ran.
    void processStore.deleteUnpairedHostCaches(readPairedHostKeys).catch(() => undefined)
  }
  return processStore
}

export function resetProcessGenerationStoreForTests(): void {
  processStore = null
}
