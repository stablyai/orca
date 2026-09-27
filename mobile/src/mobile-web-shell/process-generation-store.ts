import { createGenerationStore, type GenerationStore } from './generation-store'
import { createExpoGenerationFileSystem } from './generation-store-file-system'

let processStore: GenerationStore | null = null

/** The one store every native caller shares. Its queue is what orders writes to the host index and
 *  the update-failure log, and a second instance has its own: a removal issued through one loses
 *  the write the mounted session's lands inside it. */
export function processGenerationStore(): GenerationStore {
  processStore ??= createGenerationStore({ fileSystem: createExpoGenerationFileSystem() })
  return processStore
}

export function resetProcessGenerationStoreForTests(): void {
  processStore = null
}
