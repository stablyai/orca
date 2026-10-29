import { createGenerationStore, type GenerationStore } from './generation-store'
import { createExpoGenerationFileSystem } from './generation-store-file-system'

let processStore: GenerationStore | null = null

// Share one store queue across native callers so host removal cannot interleave with generation/index/failure-log writes.
export function processGenerationStore(): GenerationStore {
  processStore ??= createGenerationStore({ fileSystem: createExpoGenerationFileSystem() })
  return processStore
}

export function resetProcessGenerationStoreForTests(): void {
  processStore = null
}
