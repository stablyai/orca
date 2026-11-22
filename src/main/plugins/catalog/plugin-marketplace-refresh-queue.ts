import type { PluginMarketplaceSourceState } from './plugin-marketplace-projection'

export async function runSourceRefresh(
  refreshChains: Map<string, Promise<PluginMarketplaceSourceState>>,
  removingSources: ReadonlyMap<string, number>,
  sourceId: string,
  run: () => Promise<PluginMarketplaceSourceState>
): Promise<PluginMarketplaceSourceState> {
  if (removingSources.has(sourceId)) {
    throw new Error('catalog removal is in progress')
  }
  const previous = refreshChains.get(sourceId) ?? Promise.resolve(null)
  const refresh = previous.catch(() => null).then(run)
  refreshChains.set(sourceId, refresh)
  try {
    return await refresh
  } finally {
    if (refreshChains.get(sourceId) === refresh) {
      refreshChains.delete(sourceId)
    }
  }
}
