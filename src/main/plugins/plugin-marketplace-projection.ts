import {
  OFFICIAL_MARKETPLACE_OWNER,
  isOfficialMarketplaceGitSource,
  isOfficialOrganizationGitSource,
  isOfficialPluginIdentity,
  type PluginMarketplaceEntry,
  type PluginMarketplaceGitSource
} from '../../shared/plugins/plugin-marketplace'
import type { PluginKillListEntry } from '../../shared/plugins/plugin-kill-list'
import type {
  PluginMarketplaceCachedSnapshot,
  PluginMarketplaceRegisteredSource
} from './plugin-marketplace-store'
import { selectPluginCatalogRelease } from '../../shared/plugins/plugin-catalog'
import { pluginShaImageUrl, type PluginHostImages } from '../../shared/plugins/plugin-image-url'
import type { PluginCatalogRelease } from '../../shared/plugins/plugin-catalog-release'

export type PluginMarketplaceSourceState = {
  id: string
  source: PluginMarketplaceGitSource
  addedAt: number
  marketplace: {
    name: string
    owner: string
    resolvedCommit: string
    fetchedAt: number
  } | null
  stale: boolean
  official: boolean
  error?: string
}

export type PluginMarketplaceListing = {
  marketplaceSourceId: string
  marketplaceName: string
  marketplaceOwner: string
  marketplaceCommit: string
  pluginKey: string
  source: PluginMarketplaceEntry['source']
  description?: string
  categories: string[]
  official: boolean
  bundled: boolean
  blockedByKillList?: { reason: string; advisoryUrl?: string }
  /** The release offered to this host: the newest it can install, else the one needing the least
   *  newer Orca. Absent for v1 catalogs. */
  release?: PluginCatalogRelease
  /** Every release the catalog lists for this plugin, newest first. */
  releases?: PluginCatalogRelease[]
  /** The offered release's images, served by main from verified bytes. */
  images?: PluginHostImages
} & PluginCatalogListingDetails

/** Display fields a release carries, flattened so list rows need not know release records. */
export type PluginCatalogListingDetails = {
  name?: string
  version?: string
  license?: string
  repository?: string
  homepage?: string
  updatedAt?: string
  changelog?: string
}

const DETAIL_KEYS = [
  'name',
  'license',
  'repository',
  'homepage',
  'updatedAt',
  'changelog'
] as const satisfies readonly (keyof PluginCatalogListingDetails & keyof PluginCatalogRelease)[]

/** Catalog images as the renderer loads them: hash-addressed, verified, never hotlinked. */
export function pluginCatalogListingImages(release: PluginCatalogRelease | undefined): {
  images?: PluginHostImages
} {
  const images = release?.images
  if (!images) {
    return {}
  }
  const host = (image: { sha256: string; alt: string; width: number; height: number }) => ({
    url: pluginShaImageUrl(image.sha256),
    alt: image.alt,
    width: image.width,
    height: image.height
  })
  return {
    images: {
      ...(images.icon ? { icon: host(images.icon) } : {}),
      ...(images.cover ? { cover: host(images.cover) } : {}),
      ...(images.screenshots?.length ? { screenshots: images.screenshots.map(host) } : {})
    }
  }
}

/** The release to offer this host; without a host version, the newest. */
export function offeredCatalogRelease(
  releases: readonly PluginCatalogRelease[] | undefined,
  hostVersion: string | null
): PluginCatalogRelease | undefined {
  if (!releases) {
    return undefined
  }
  return hostVersion ? selectPluginCatalogRelease(releases, hostVersion) : releases[0]
}

export function pluginCatalogListingDetails(
  release: PluginCatalogRelease | undefined
): PluginCatalogListingDetails {
  if (!release) {
    return {}
  }
  const details: PluginCatalogListingDetails = { version: release.version }
  for (const key of DETAIL_KEYS) {
    const value = release[key]
    if (value !== undefined) {
      details[key] = value
    }
  }
  return details
}

/** One catalog entry as clients see it: trust is derived here, never taken from the catalog. */
export function pluginMarketplaceListing(input: {
  source: PluginMarketplaceRegisteredSource
  snapshot: PluginMarketplaceCachedSnapshot
  entry: PluginMarketplaceEntry
  hostVersion: string | null
  blocked: PluginKillListEntry | null
}): PluginMarketplaceListing {
  const { source, snapshot, entry, blocked } = input
  const release = offeredCatalogRelease(entry.releases, input.hostVersion)
  const official =
    isOfficialMarketplaceGitSource(source.source.url) &&
    snapshot.marketplace.owner.toLowerCase() === OFFICIAL_MARKETPLACE_OWNER &&
    isOfficialPluginIdentity(entry.id) &&
    isOfficialOrganizationGitSource(entry.source.url)
  return {
    marketplaceSourceId: source.id,
    marketplaceName: snapshot.marketplace.name,
    marketplaceOwner: snapshot.marketplace.owner,
    marketplaceCommit: snapshot.marketplaceCommit,
    pluginKey: entry.id,
    source: entry.source,
    ...(entry.description ? { description: entry.description } : {}),
    categories: entry.categories,
    official,
    bundled: false,
    ...(release ? { release, releases: entry.releases } : {}),
    ...pluginCatalogListingDetails(release),
    ...pluginCatalogListingImages(release),
    ...(blocked
      ? {
          blockedByKillList: {
            reason: blocked.reason,
            ...(blocked.advisoryUrl ? { advisoryUrl: blocked.advisoryUrl } : {})
          }
        }
      : {})
  }
}
