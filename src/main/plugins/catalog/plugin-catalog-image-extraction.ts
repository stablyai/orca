import { createHash } from 'node:crypto'
import type { PluginCatalogRelease } from '../../../shared/plugins/catalog/plugin-catalog-release'
import { readPluginImageHeader } from '../../../shared/plugins/plugin-image-format'
import {
  PLUGIN_IMAGE_RULES,
  pluginImageRuleError,
  type PluginCatalogImages,
  type PluginImageKind
} from '../../../shared/plugins/plugin-image-fields'
import type { PluginMarketplace } from '../../../shared/plugins/catalog/plugin-marketplace'

// Why a catalog-wide cap: a large catalog must not turn one refresh into an unbounded download.
const CATALOG_IMAGES_MAX_BYTES = 64 * 1024 * 1024

type CatalogImage = NonNullable<PluginCatalogImages['cover']>

export type CatalogBlobReader = (path: string, maxBytes: number) => Promise<Buffer | null>

/** Reads every image a catalog references from the catalog repository at its commit, keeps the
 *  ones whose bytes match their hash, size and format, and drops the rest from the listing. */
export async function extractCatalogImages(
  marketplace: PluginMarketplace,
  readBlob: CatalogBlobReader
): Promise<{ marketplace: PluginMarketplace; images: Buffer[] }> {
  const verified = new Map<string, Buffer>()
  const rejected = new Set<string>()
  let budget = CATALOG_IMAGES_MAX_BYTES
  const check = async (image: CatalogImage, kind: PluginImageKind): Promise<boolean> => {
    if (verified.has(image.sha256)) {
      return true
    }
    if (rejected.has(image.sha256)) {
      return false
    }
    const maxBytes = Math.min(PLUGIN_IMAGE_RULES[kind].maxBytes, budget)
    const bytes = maxBytes > 0 ? await readBlob(image.path, maxBytes).catch(() => null) : null
    const info = bytes ? readPluginImageHeader(bytes) : 'missing'
    const ok =
      bytes !== null &&
      typeof info !== 'string' &&
      createHash('sha256').update(bytes).digest('hex') === image.sha256 &&
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
  const keep = async (images: PluginCatalogImages): Promise<PluginCatalogImages> => {
    const icon = images.icon && (await check(images.icon, 'icon')) ? images.icon : undefined
    const cover = images.cover && (await check(images.cover, 'cover')) ? images.cover : undefined
    const screenshots: CatalogImage[] = []
    for (const shot of images.screenshots ?? []) {
      if (await check(shot, 'screenshot')) {
        screenshots.push(shot)
      }
    }
    return {
      ...(icon ? { icon } : {}),
      ...(cover ? { cover } : {}),
      ...(screenshots.length ? { screenshots } : {})
    }
  }
  const plugins: PluginMarketplace['plugins'] = []
  for (const entry of marketplace.plugins) {
    if (!entry.releases) {
      plugins.push(entry)
      continue
    }
    const releases: PluginCatalogRelease[] = []
    for (const release of entry.releases) {
      if (!release.images) {
        releases.push(release)
        continue
      }
      const { images, ...rest } = release
      const kept = await keep(images)
      releases.push(Object.keys(kept).length ? { ...rest, images: kept } : rest)
    }
    plugins.push({ ...entry, releases })
  }
  return { marketplace: { ...marketplace, plugins }, images: [...verified.values()] }
}
