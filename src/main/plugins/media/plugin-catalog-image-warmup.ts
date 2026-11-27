import type { PluginImageKind } from '../../../shared/plugins/images/plugin-image-fields'
import type { CatalogImage } from '../catalog/plugin-catalog-image-extraction'
import type { PluginMarketplaceCachedSnapshot } from '../catalog/plugin-marketplace-store'
import type { CatalogSnapshotImages } from './plugin-catalog-snapshot-images'

// Why 64 MiB: what a refresh used to download for artwork, half the image cache, so warming one
// catalog cannot evict another's.
const WARM_BUDGET_BYTES = 64 * 1024 * 1024
const WARM_BATCH_SIZE = 6

/**
 * Proves and caches a newly published snapshot's artwork in listing order, one read batch at a
 * time, so the Plugins page paints from the cache as it did when refresh downloaded every image.
 * Batches run one after another so a page's own reads wait behind at most one warm batch.
 */
export async function warmCatalogImages(input: {
  snapshots: CatalogSnapshotImages
  snapshot: PluginMarketplaceCachedSnapshot
  isCurrent: () => boolean
  read: (kind: PluginImageKind, image: CatalogImage) => Promise<unknown>
}): Promise<void> {
  const { snapshots, snapshot } = input
  const listed = await snapshots.listing(snapshot)
  if (!listed) {
    return
  }
  let budget = WARM_BUDGET_BYTES
  const images = snapshots.images(snapshot).filter(({ image }) => {
    const size = listed.get(image.path)?.size
    if (!size || size > budget) {
      return false
    }
    budget -= size
    return true
  })
  for (let start = 0; start < images.length && input.isCurrent(); start += WARM_BATCH_SIZE) {
    await Promise.all(
      images
        .slice(start, start + WARM_BATCH_SIZE)
        .map(({ kind, image }) => input.read(kind, image).catch(() => null))
    )
  }
}
