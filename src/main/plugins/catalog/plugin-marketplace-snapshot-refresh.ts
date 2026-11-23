import {
  fetchPluginMarketplace,
  type PluginMarketplaceFetchResult
} from './plugin-marketplace-fetch'
import { validateMarketplaceProvenance } from './plugin-marketplace-provenance'
import type { PluginCatalogRepositoryStore } from './plugin-catalog-repository'
import type {
  CatalogRepositorySlot,
  PluginMarketplaceCachedSnapshot,
  PluginMarketplaceRegisteredSource,
  PluginMarketplaceStore
} from './plugin-marketplace-store'

export type MarketplaceFetcher = (
  source: PluginMarketplaceRegisteredSource
) => Promise<PluginMarketplaceFetchResult>

export async function refreshMarketplaceSnapshot(
  store: PluginMarketplaceStore,
  repositories: PluginCatalogRepositoryStore | null,
  fetcher: MarketplaceFetcher | undefined,
  repositorySweep: Promise<void> | undefined,
  source: PluginMarketplaceRegisteredSource,
  register: () =>
    | PluginMarketplaceRegisteredSource
    | Promise<PluginMarketplaceRegisteredSource> = () => source
): Promise<PluginMarketplaceCachedSnapshot> {
  const save = async (
    fetched: PluginMarketplaceFetchResult,
    catalogRepository?: CatalogRepositorySlot
  ) => {
    validateMarketplaceProvenance(source, fetched)
    return store.writeSnapshot({ source: await register(), ...fetched, catalogRepository })
  }
  if (fetcher) {
    return save(await fetcher(source))
  }
  await repositorySweep
  const published = await store.readSnapshot(source.id).catch(() => null)
  return fetchPluginMarketplace(source, { repositories: repositories!, published }, save)
}
