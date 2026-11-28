import {
  OFFICIAL_MARKETPLACE_OWNER,
  isOfficialMarketplaceGitSource,
  isOfficialOrganizationGitSource,
  isReservedPluginIdentity
} from '../../../shared/plugins/catalog/plugin-marketplace'
import type { PluginMarketplaceFetchResult } from './plugin-marketplace-fetch'
import type {
  PluginMarketplaceCachedSnapshot,
  PluginMarketplaceRegisteredSource,
  PluginMarketplaceStore
} from './plugin-marketplace-store'
import type { PluginImageCache } from '../media/plugin-image-cache'

export async function saveMarketplaceSnapshot(
  store: PluginMarketplaceStore,
  source: PluginMarketplaceRegisteredSource,
  fetched: PluginMarketplaceFetchResult,
  cache: PluginImageCache | null
): Promise<PluginMarketplaceCachedSnapshot> {
  const snapshot = await store.writeSnapshot({ source, ...fetched })
  void pruneMarketplaceImageCache(store, cache).catch(() => undefined)
  return snapshot
}

export async function readMarketplaceSnapshots(
  sources: readonly PluginMarketplaceRegisteredSource[],
  store: PluginMarketplaceStore
): Promise<
  { source: PluginMarketplaceRegisteredSource; snapshot: PluginMarketplaceCachedSnapshot }[]
> {
  const snapshots = await Promise.all(
    sources.map(async (source) => ({ source, snapshot: await store.readSnapshot(source.id) }))
  )
  return snapshots.filter(
    (
      candidate
    ): candidate is {
      source: PluginMarketplaceRegisteredSource
      snapshot: PluginMarketplaceCachedSnapshot
    } => candidate.snapshot !== null
  )
}

export async function pruneMarketplaceImageCache(
  store: PluginMarketplaceStore,
  cache: PluginImageCache | null
): Promise<void> {
  if (!cache) {
    return
  }
  const sources = await store.listSources()
  const retain = new Set<string>()
  for (const source of sources) {
    // Abort pruning if any snapshot cannot be read so live catalog images are never evicted.
    const snapshot = await store.readSnapshot(source.id)
    if (snapshot?.schemaVersion !== 2) {
      continue
    }
    for (const plugin of snapshot.marketplace.plugins) {
      for (const release of plugin.releases ?? []) {
        const images = release.images
        if (!images) {
          continue
        }
        if (images.icon) {
          retain.add(images.icon.sha256)
        }
        if (images.cover) {
          retain.add(images.cover.sha256)
        }
        for (const shot of images.screenshots ?? []) {
          retain.add(shot.sha256)
        }
      }
    }
  }
  await cache.prune(retain)
}

export async function cacheValidatedMarketplace(
  source: PluginMarketplaceRegisteredSource,
  fetched: PluginMarketplaceFetchResult,
  cache: PluginImageCache | null
): Promise<PluginMarketplaceFetchResult> {
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

export function validateMarketplaceProvenance(
  source: PluginMarketplaceRegisteredSource,
  fetched: PluginMarketplaceFetchResult
): void {
  const official = isOfficialMarketplaceGitSource(source.source.url)
  if (official && fetched.marketplace.owner.toLowerCase() !== OFFICIAL_MARKETPLACE_OWNER) {
    throw new Error('official marketplace metadata has an unexpected owner')
  }
  for (const entry of fetched.marketplace.plugins) {
    if (!isReservedPluginIdentity(entry.id)) {
      continue
    }
    if (!official) {
      throw new Error(
        `${entry.id} uses a name reserved for official Orca plugins; only Orca's official catalog may list it`
      )
    }
    if (!isOfficialOrganizationGitSource(entry.source.url)) {
      throw new Error(
        `reserved plugin identity ${entry.id} must resolve to the stablyai organization`
      )
    }
  }
}
