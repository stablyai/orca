import type { PluginMarketplaceInstaller } from './plugin-marketplace-installer'
import { marketplaceInstallOf } from './plugin-marketplace-install-origin'
import type { PluginMarketplaceSourceState } from './plugin-marketplace-projection'

/** How long one update review's catalog refresh is reused by its other previews. */
const SHARED_REFRESH_WINDOW_MS = 10_000

type SourceRefresh = (sourceId: string) => Promise<PluginMarketplaceSourceState>

/**
 * Reuses a refresh of a source started in the last few seconds instead of fetching again.
 * Why: one update review previews several plugins from the same catalog, one call each.
 */
export function sharedSourceRefresh(
  refresh: SourceRefresh
): (sourceId: string, now?: number) => Promise<PluginMarketplaceSourceState> {
  const recent = new Map<
    string,
    { startedAt: number; refresh: Promise<PluginMarketplaceSourceState> }
  >()
  return (sourceId, now = Date.now()) => {
    const known = recent.get(sourceId)
    if (known && now - known.startedAt < SHARED_REFRESH_WINDOW_MS) {
      return known.refresh
    }
    const started = refresh(sourceId)
    recent.set(sourceId, { startedAt: now, refresh: started })
    // Why forget rejections: those mean no usable catalog at all (unknown source, nothing cached),
    // so the next check should try again. A fetch that fails over a cache resolves and is reused.
    started.catch(() => {
      if (recent.get(sourceId)?.refresh === started) {
        recent.delete(sourceId)
      }
    })
    return started
  }
}

/**
 * Re-fetches the catalog an installed plugin updates from, before its update preview. Why: a user
 * checking for updates must see releases published since the last fetch. A failed fetch keeps the
 * cached catalog, so offline still previews what it knows.
 */
export async function refreshInstalledPluginCatalog(
  services: {
    installer: Pick<PluginMarketplaceInstaller, 'readInstallLockfile'>
    marketplace: { refreshSourceShared: (sourceId: string) => Promise<unknown> }
  },
  pluginKey: string
): Promise<void> {
  try {
    // Why the lock entry, not the cached listing: a snapshot that lost the listing is exactly the
    // one a refresh would repair.
    const lock = await services.installer.readInstallLockfile()
    const installed = marketplaceInstallOf(lock.plugins[pluginKey] ?? null)
    await (installed ? services.marketplace.refreshSourceShared(installed.sourceId) : null)
  } catch (error) {
    console.warn('[plugins] catalog refresh before update preview failed:', error)
  }
}
