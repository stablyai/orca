import { createGenerationStore, type GenerationStore } from './generation-store'
import { createExpoGenerationFileSystem } from './generation-store-file-system'
import { deriveHostCacheKey } from './host-cache-key'

let processStore: GenerationStore | null = null

// Share one store queue across native callers so host removal cannot interleave with generation/index/failure-log writes.
export function processGenerationStore(): GenerationStore {
  processStore ??= createGenerationStore({ fileSystem: createExpoGenerationFileSystem() })
  return processStore
}

// The page version of the build the host's next screen opens; null without a readable cache. The read is the one that screen's shell makes anyway, so the store memoizes it for the shell.
export async function readCachedPageVersion(hostId: string): Promise<number | null> {
  try {
    const active = await processGenerationStore().readActiveGeneration(deriveHostCacheKey(hostId))
    return active?.manifest.pageVersion ?? null
  } catch {
    return null
  }
}

export function resetProcessGenerationStoreForTests(): void {
  processStore = null
}
