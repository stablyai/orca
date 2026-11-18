import type { PluginMarketplaceRegisteredSource } from './plugin-marketplace-store'
import type { PluginMarketplaceFetchResult } from './plugin-marketplace-fetch'
import type { PluginImageCache } from '../media/plugin-image-cache'
import { validateMarketplaceProvenance } from './plugin-marketplace-provenance'

export async function fetchAndCacheMarketplace(
  source: PluginMarketplaceRegisteredSource,
  fetcher: (source: PluginMarketplaceRegisteredSource) => Promise<PluginMarketplaceFetchResult>,
  cache: PluginImageCache | null
): Promise<PluginMarketplaceFetchResult> {
  const fetched = await fetcher(source)
  validateMarketplaceProvenance(source, fetched)
  if (cache) {
    await Promise.all(
      (fetched.images ?? []).map((image) =>
        cache.put(image).catch((error: unknown) => {
          console.warn('[plugins] could not cache marketplace image:', error)
          return null
        })
      )
    )
  }
  return fetched
}
