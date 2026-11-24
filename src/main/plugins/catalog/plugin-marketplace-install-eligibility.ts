import { isSamePluginSource } from '../../../shared/plugins/catalog/plugin-marketplace'
import type { PluginLockEntry } from '../../../shared/plugins/installation/plugin-install-lockfile'
import { getUserPluginsDir } from '../discovery/plugin-discovery'
import { pluginTreeHashMatches } from '../artifacts/plugin-content-integrity'
import { readPluginLockfile } from '../installation/plugin-install-lockfile-store'
import { serializePluginMutation } from '../installation/plugin-mutation-queue'
import { marketplaceSourceId } from './plugin-marketplace-store'
import type {
  PluginMarketplaceListing,
  PluginMarketplaceService
} from './plugin-marketplace-service'

export const CATALOG_REFRESH_PENDING =
  'The plugin catalog is still updating. Try again in a moment.'

export function marketplaceInstallRefreshError(error: unknown): string {
  return error instanceof Error && error.message === CATALOG_REFRESH_PENDING
    ? error.message
    : 'marketplace refresh failed; review the plugin again'
}

export class MarketplaceReviewRequiredError extends Error {
  constructor() {
    super('marketplace changed after preview; review the plugin again')
  }
}

export async function waitForMarketplaceSourceRefresh(
  pending: Promise<unknown> | undefined
): Promise<void> {
  if (!pending) {
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(CATALOG_REFRESH_PENDING)), 10_000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

type CatalogOffer = Pick<
  PluginMarketplaceListing,
  'marketplaceSourceId' | 'pluginKey' | 'source' | 'release'
>

/** Only the admitted offer must stay fixed; another plugin's catalog edit is unrelated. */
export function withMarketplaceInstallEligibility<T>(
  marketplace: PluginMarketplaceService,
  expected: CatalogOffer,
  write: () => T | Promise<T>
): Promise<T> {
  return marketplace.withSourceSnapshot(expected.marketplaceSourceId, async () => {
    const listing = await marketplace.findPlugin(expected.marketplaceSourceId, expected.pluginKey)
    if (
      !listing ||
      listing.blockedByKillList ||
      !isSamePluginSource(listing.source, expected.source) ||
      listing.source.ref !== expected.source.ref ||
      listing.release?.version !== expected.release?.version ||
      listing.release?.commit !== expected.release?.commit ||
      listing.release?.contentHash !== expected.release?.contentHash
    ) {
      throw new MarketplaceReviewRequiredError()
    }
    return write()
  })
}

/** Approval grants the installed bytes a configured catalog still lists, not its historical revision. */
export function withInstalledMarketplaceEligibility(
  marketplace: PluginMarketplaceService,
  userDataPath: string,
  pluginKey: string,
  write: (installed: PluginLockEntry) => void
): Promise<void> {
  return serializePluginMutation(getUserPluginsDir(userDataPath), async () => {
    const entry = (await readPluginLockfile(getUserPluginsDir(userDataPath))).plugins[pluginKey]
    if (!entry) {
      throw new MarketplaceReviewRequiredError()
    }
    if (entry.source.kind !== 'marketplace') {
      return write(entry)
    }
    const installedSource = entry.source
    const sourceId = marketplaceSourceId({
      kind: 'git',
      url: installedSource.marketplace.url,
      ref: installedSource.marketplace.ref
    })
    return marketplace.withSourceSnapshot(sourceId, async () => {
      const listing = await marketplace.findPlugin(sourceId, pluginKey)
      const releases = listing?.releases ?? (listing?.release ? [listing.release] : null)
      const listed =
        listing &&
        (releases
          ? releases.some(
              (release) =>
                release.version === entry.version &&
                pluginTreeHashMatches(release.contentHash, entry.contentHash)
            )
          : isSamePluginSource(listing.source, installedSource.plugin) &&
            listing.source.ref === installedSource.plugin.ref)
      if (!listed || listing?.blockedByKillList) {
        throw new MarketplaceReviewRequiredError()
      }
      return write(entry)
    })
  })
}
