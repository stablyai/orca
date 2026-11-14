import type { PluginCatalogRelease } from '../../../shared/plugins/catalog/plugin-catalog-release'
import { readPluginImageHeader } from '../../../shared/plugins/images/plugin-image-format'
import {
  PLUGIN_IMAGE_RULES,
  pluginImageRuleError,
  type PluginCatalogImages,
  type PluginImageKind
} from '../../../shared/plugins/images/plugin-image-fields'
import type {
  PluginMarketplace,
  PluginMarketplaceEntry
} from '../../../shared/plugins/catalog/plugin-marketplace'
import { sha256Hex } from '../plugin-image-cache'

// Why a catalog-wide cap: a large catalog must not turn one refresh into an unbounded download.
const CATALOG_IMAGES_MAX_BYTES = 64 * 1024 * 1024

type CatalogImage = NonNullable<PluginCatalogImages['cover']>

export type CatalogBlobReader = (path: string, maxBytes: number) => Promise<Buffer | null>

/** Gives an entry images before they are checked, with a reader for the bytes it already read. */
export type CatalogEntryImageFill = (
  entry: PluginMarketplaceEntry,
  readBlob: CatalogBlobReader
) => Promise<{ entry: PluginMarketplaceEntry; readBlob: CatalogBlobReader }>

/** Reads every image a catalog references from the catalog repository at its commit, keeps the
 *  ones whose bytes match their hash, size and format, and drops the rest from the listing.
 *  `maxImageBytes` defaults to the catalog-wide cap. */
export async function extractCatalogImages(
  marketplace: PluginMarketplace,
  readBlob: CatalogBlobReader,
  fill?: CatalogEntryImageFill,
  options?: { maxImageBytes?: number }
): Promise<{ marketplace: PluginMarketplace; images: Buffer[] }> {
  const verified = new Map<string, Buffer>()
  const rejected = new Set<string>()
  let budget = options?.maxImageBytes ?? CATALOG_IMAGES_MAX_BYTES
  const check = async (
    image: CatalogImage,
    kind: PluginImageKind,
    read: CatalogBlobReader
  ): Promise<boolean> => {
    if (verified.has(image.sha256)) {
      return true
    }
    if (rejected.has(image.sha256)) {
      return false
    }
    const maxBytes = Math.min(PLUGIN_IMAGE_RULES[kind].maxBytes, budget)
    const bytes = maxBytes > 0 ? await read(image.path, maxBytes).catch(() => null) : null
    const info = bytes ? readPluginImageHeader(bytes) : 'missing'
    const ok =
      bytes !== null &&
      typeof info !== 'string' &&
      sha256Hex(bytes) === image.sha256 &&
      info.width === image.width &&
      info.height === image.height &&
      pluginImageRuleError(kind, info, bytes.byteLength) === null
    if (ok && bytes) {
      budget -= bytes.byteLength
      verified.set(image.sha256, bytes)
    } else {
      rejected.add(image.sha256)
    }
    return ok
  }
  // Why this order: a card needs its cover and icon. Screenshots belong to the plugin page, so an
  // earlier plugin's screenshots must not spend the shared cap before later cards have theirs.
  type ReleaseImages = {
    release: PluginCatalogRelease
    images: PluginCatalogImages
    read: CatalogBlobReader
  }
  const prepared: { entry: PluginMarketplaceEntry; imageReleases: ReleaseImages[] }[] = []
  for (const listed of marketplace.plugins) {
    const { entry, readBlob: read } = fill
      ? await fill(listed, readBlob)
      : { entry: listed, readBlob }
    const imageReleases: ReleaseImages[] = []
    for (const release of entry.releases ?? []) {
      if (release.images) {
        imageReleases.push({ release, images: release.images, read })
      }
    }
    prepared.push({ entry, imageReleases })
  }
  const kept = new Map<ReleaseImages, PluginCatalogImages>()
  const keep = (item: ReleaseImages, images: PluginCatalogImages) => {
    kept.set(item, images)
  }
  for (const item of prepared) {
    for (const release of item.imageReleases) {
      const cover = release.images.cover
      if (cover && (await check(cover, 'cover', release.read))) {
        keep(release, { ...kept.get(release), cover })
      }
    }
  }
  for (const item of prepared) {
    for (const release of item.imageReleases) {
      const icon = release.images.icon
      if (icon && (await check(icon, 'icon', release.read))) {
        keep(release, { ...kept.get(release), icon })
      }
    }
  }
  for (const item of prepared) {
    for (const release of item.imageReleases) {
      const screenshots: CatalogImage[] = []
      for (const shot of release.images.screenshots ?? []) {
        if (await check(shot, 'screenshot', release.read)) {
          screenshots.push(shot)
        }
      }
      if (screenshots.length) {
        keep(release, { ...kept.get(release), screenshots })
      }
    }
  }
  const plugins: PluginMarketplace['plugins'] = []
  for (const item of prepared) {
    if (!item.entry.releases) {
      plugins.push(item.entry)
      continue
    }
    const releases: PluginCatalogRelease[] = []
    for (const release of item.entry.releases) {
      const work = item.imageReleases.find((candidate) => candidate.release === release)
      if (!work) {
        releases.push(release)
        continue
      }
      const images = kept.get(work)
      const ordered: PluginCatalogImages = {
        ...(images?.icon ? { icon: images.icon } : {}),
        ...(images?.cover ? { cover: images.cover } : {}),
        ...(images?.screenshots?.length ? { screenshots: images.screenshots } : {})
      }
      const { images: _listed, ...rest } = release
      releases.push(Object.keys(ordered).length ? { ...rest, images: ordered } : rest)
    }
    plugins.push({ ...item.entry, releases })
  }
  return { marketplace: { ...marketplace, plugins }, images: [...verified.values()] }
}
