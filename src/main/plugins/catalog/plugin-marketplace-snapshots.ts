import type {
  PluginMarketplaceStore,
  PluginMarketplaceRegisteredSource,
  PluginMarketplaceCachedSnapshot
} from './plugin-marketplace-store'
import { pluginMarketplaceErrorMessage } from './plugin-marketplace-error-message'
import { pluginMarketplaceSourceState } from './plugin-marketplace-projection'
import type { PluginMarketplaceTeamPolicy } from './plugin-marketplace-team-policy'
import type { PluginCatalogRepositoryStore } from './plugin-catalog-repository'

export function sweepUnpublishedCatalogRepositories(
  repositories: PluginCatalogRepositoryStore | null,
  store: PluginMarketplaceStore,
  policy: PluginMarketplaceTeamPolicy
): Promise<void> | undefined {
  return repositories
    ?.sweep(
      Promise.all([store.listSources(), store.snapshotSourceIds()]).then(
        ([registered, snapshots]) => [
          ...registered.map(({ id }) => id),
          ...policy.configuredManagedSourceIds(),
          // Capabilities may not be loaded yet. Retain repositories that have a publication on disk.
          ...snapshots
        ]
      )
    )
    .catch((error: unknown) => {
      console.warn('[plugins] could not sweep retained catalog repositories:', error)
    })
}

export async function readMarketplaceSourceStates(
  store: PluginMarketplaceStore,
  policy: PluginMarketplaceTeamPolicy,
  errors: ReadonlyMap<string, string>
) {
  const sources = await policy.list(store)
  return Promise.all(
    sources.map(async (source) => {
      let error = errors.get(source.id)
      const snapshot = await store.readSnapshot(source.id).catch((cause) => {
        error = pluginMarketplaceErrorMessage(cause)
        return null
      })
      return pluginMarketplaceSourceState(source, snapshot, error, policy)
    })
  )
}

export async function readMarketplaceSnapshots(
  store: Pick<PluginMarketplaceStore, 'readSnapshot'>,
  sources: readonly PluginMarketplaceRegisteredSource[]
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
