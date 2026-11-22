import type {
  PluginMarketplaceStore,
  PluginMarketplaceRegisteredSource,
  PluginMarketplaceCachedSnapshot
} from './plugin-marketplace-store'

export async function readMarketplaceSnapshots(
  store: Pick<PluginMarketplaceStore, 'readSnapshot'>,
  sources: PluginMarketplaceRegisteredSource[]
): Promise<
  { source: PluginMarketplaceRegisteredSource; snapshot: PluginMarketplaceCachedSnapshot }[]
> {
  const snapshots = await Promise.all(
    sources.map(async (source) => ({
      source,
      snapshot: await store.readSnapshot(source.id).catch(() => null)
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
