import type { PluginMarketplaceInstaller } from './plugin-marketplace-installer'
import { marketplaceInstallOf } from './plugin-marketplace-install-origin'
import type { PluginMarketplaceSourceState } from './plugin-marketplace-projection'

/** How long one update review's catalog refresh is reused by its other previews. */
const SHARED_REFRESH_WINDOW_MS = 10_000

type SourceRefresh = (sourceId: string) => Promise<PluginMarketplaceSourceState>

export type SharedSourceRefresh = ((
  sourceId: string,
  now?: number
) => Promise<PluginMarketplaceSourceState>) & {
  /** Drops a cached refresh entry, e.g. when its marketplace source is removed. */
  evict: (sourceId: string) => void
}

/**
 * Reuses a refresh of a source started in the last few seconds instead of fetching again.
 * Why: one update review previews several plugins from the same catalog, one call each.
 */
export function sharedSourceRefresh(refresh: SourceRefresh): SharedSourceRefresh {
  const recent = new Map<
    string,
    {
      startedAt: number
      refresh: Promise<PluginMarketplaceSourceState>
      timer: ReturnType<typeof setTimeout>
    }
  >()
  const evict = (sourceId: string): void => {
    const entry = recent.get(sourceId)
    if (!entry) {
      return
    }
    clearTimeout(entry.timer)
    recent.delete(sourceId)
  }
  return Object.assign(
    (sourceId: string, now = Date.now()) => {
      for (const [id, entry] of recent) {
        const age = now - entry.startedAt
        if (age < 0 || age >= SHARED_REFRESH_WINDOW_MS) {
          evict(id)
        }
      }
      const known = recent.get(sourceId)
      if (known) {
        return known.refresh
      }
      const started = refresh(sourceId)
      const timer = setTimeout(() => {
        if (recent.get(sourceId)?.refresh === started) {
          recent.delete(sourceId)
        }
      }, SHARED_REFRESH_WINDOW_MS)
      timer.unref?.()
      recent.set(sourceId, { startedAt: now, refresh: started, timer })
      // Why forget rejections: those mean no usable catalog at all (unknown source, nothing cached),
      // so the next check should try again. A fetch that fails over a cache resolves and is reused.
      started.catch(() => {
        if (recent.get(sourceId)?.refresh === started) {
          evict(sourceId)
        }
      })
      return started
    },
    { evict }
  )
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
