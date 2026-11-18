import type {
  PluginMarketplaceStore,
  PluginMarketplaceRegisteredSource,
  PluginMarketplaceCachedSnapshot
} from './plugin-marketplace-store'

export async function readMarketplaceSnapshots(
  store: Pick<PluginMarketplaceStore, 'listSources' | 'readSnapshot'>
): Promise<
  { source: PluginMarketplaceRegisteredSource; snapshot: PluginMarketplaceCachedSnapshot }[]
> {
  const sources = await store.listSources()
  const snapshots = await Promise.all(
    sources.map(async (source) => ({
      source,
      snapshot: await store.readSnapshot(source.id)
    }))
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
