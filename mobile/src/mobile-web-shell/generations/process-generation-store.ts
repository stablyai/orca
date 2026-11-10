import { Directory, Paths } from 'expo-file-system'
import { generationStoreDirectory } from '../../../modules/orca-mobile-web-shell/src/generation-store-directory'
import { createGenerationStore, type GenerationStore } from './generation-store'
import { createExpoGenerationFileSystem } from './generation-store-file-system'
import { dropHomeSparePage } from '../home-spare-page'

const GENERATION_STORE_DIRECTORY_NAME = 'mobile-web'

let processStore: GenerationStore | null = null

// Share one store queue across native callers so host removal cannot interleave with generation/index/failure-log writes.
export function processGenerationStore(): GenerationStore {
  if (processStore === null) {
    // Builds lived in the OS cache until storage pressure or "Clear cache" emptied it and forced a full download.
    const cacheRoot = new Directory(Paths.cache, GENERATION_STORE_DIRECTORY_NAME).uri
    // A binary from before the durable directory keeps the cache root.
    const durableRoot = generationStoreDirectory(GENERATION_STORE_DIRECTORY_NAME)
    processStore = createGenerationStore({
      fileSystem: createExpoGenerationFileSystem(durableRoot ?? cacheRoot),
      beforeHostFilesDeleted: dropHomeSparePage,
      ...(durableRoot === null ? {} : { legacyRootUri: cacheRoot })
    })
  }
  return processStore
}

export function resetProcessGenerationStoreForTests(): void {
  processStore = null
}
