import type { PluginMarketplaceService } from './plugin-marketplace-service'

export const MISSING_SNAPSHOT_RETRY_MS = 15 * 60 * 1000

type StaleRefreshMarketplace = Pick<PluginMarketplaceService, 'listSources' | 'refreshSource'>

/**
 * Refreshes catalogs whose snapshot is older than maxAgeMs (or missing), at most once per source
 * per window.
 * Why: background passes skip catalogs when nothing is installed from one (#45214), so a catalog
 * view keeps listings current instead.
 */
export function createStaleMarketplaceRefresh(
  marketplace: StaleRefreshMarketplace
): (maxAgeMs: number, now?: number) => Promise<void> {
  const attemptedAt = new Map<string, number>()
  let running: Promise<void> | null = null
  const run = async (maxAgeMs: number, now: number): Promise<void> => {
    const sources = await marketplace.listSources()
    await Promise.all(
      sources.map(async ({ id, marketplace: snapshot }) => {
        const attempted = attemptedAt.get(id)
        // Why retry missing sooner: a source whose first fetch failed offline has nothing to show.
        const retryAfterMs = snapshot ? maxAgeMs : MISSING_SNAPSHOT_RETRY_MS
        if (
          (snapshot && now - snapshot.fetchedAt < maxAgeMs) ||
          (attempted !== undefined && now - attempted < retryAfterMs)
        ) {
          return
        }
        attemptedAt.set(id, now)
        // Why swallow: cached listings stay usable; manual Refresh reports failures.
        await marketplace.refreshSource(id).catch(() => undefined)
      })
    )
  }
  return (maxAgeMs, now = Date.now()) =>
    (running ??= run(maxAgeMs, now).finally(() => {
      running = null
    }))
}
