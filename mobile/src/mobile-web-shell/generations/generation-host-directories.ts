import { joinUri } from './generation-cache-uri'
import type { GenerationDirectoryEntry, GenerationFileSystem } from './generation-store-file-system'
import { isHostCacheKey } from './host-cache-key'

export const GENERATIONS_DIRECTORY_NAME = 'generations'

// One directory per host under the cache root; anything else there is not the store's.
export async function listGenerationHostDirectories(
  fs: GenerationFileSystem
): Promise<readonly GenerationDirectoryEntry[]> {
  const entries = await fs.list(fs.rootUri)
  return entries.filter((entry) => entry.isDirectory && isHostCacheKey(entry.name))
}

// Count/evict only hosts with generations; evicting staged-only hosts would delete a tree awaiting commit. Sweeps still visit them.
export async function listActivatedGenerationHosts(
  fs: GenerationFileSystem
): Promise<readonly string[]> {
  const activated: string[] = []
  for (const host of await listGenerationHostDirectories(fs)) {
    const generations = await fs.list(joinUri(fs.rootUri, host.name, GENERATIONS_DIRECTORY_NAME))
    if (generations.some((entry) => entry.isDirectory)) {
      activated.push(host.name)
    }
  }
  return activated
}
