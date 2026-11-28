import type { PluginCatalogRelease } from '../../../shared/plugins/catalog/plugin-catalog-release'
import {
  readPluginImageHeader,
  type PluginImageInfo
} from '../../../shared/plugins/images/plugin-image-format'
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
import { sha256Hex } from '../media/plugin-image-cache'

// Why a catalog-wide cap: a large catalog must not turn one refresh into an unbounded download.
const CATALOG_IMAGES_MAX_BYTES = 64 * 1024 * 1024

type CatalogImage = NonNullable<PluginCatalogImages['cover']>

export type CatalogBlobReader = (path: string, maxBytes: number) => Promise<Buffer | null>

/** What one fetch learned about buffers its reader hands out again, so repeated extraction passes
 *  hash, scan and parse each one once. */
export type CatalogBufferMemo = {
  digests: WeakMap<Uint8Array, string>
  headers: WeakMap<Uint8Array, PluginImageInfo | string>
  manifests: WeakMap<Uint8Array, unknown>
}

export function createCatalogBufferMemo(): CatalogBufferMemo {
  return { digests: new WeakMap(), headers: new WeakMap(), manifests: new WeakMap() }
}

/** Gives an entry images before they are checked, with a reader for the bytes it already read. */
export type CatalogEntryImageFill = (
  entry: PluginMarketplaceEntry,
  readBlob: CatalogBlobReader,
  remainingBudget: number
) => Promise<{ entry: PluginMarketplaceEntry; readBlob: CatalogBlobReader }>

/** Reads every image a catalog references from the catalog repository at its commit, keeps the
 *  ones whose bytes match their hash, size and format, and drops the rest from the listing. */
export async function extractCatalogImages(
  marketplace: PluginMarketplace,
  readBlob: CatalogBlobReader,
  fill?: CatalogEntryImageFill,
  memo?: CatalogBufferMemo
): Promise<{ marketplace: PluginMarketplace; images: Buffer[] }> {
  const verified = new Map<string, Buffer>()
  const rejected = new Set<string>()
  let budget = CATALOG_IMAGES_MAX_BYTES
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
    const info = bytes ? catalogImageHeader(bytes, memo) : 'missing'
    const ok =
      bytes !== null &&
      typeof info !== 'string' &&
      catalogImageDigest(bytes, memo) === image.sha256 &&
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
  const keep = async (
    images: PluginCatalogImages,
    read: CatalogBlobReader
  ): Promise<PluginCatalogImages> => {
    const icon = images.icon && (await check(images.icon, 'icon', read)) ? images.icon : undefined
    const cover =
      images.cover && (await check(images.cover, 'cover', read)) ? images.cover : undefined
    const screenshots: CatalogImage[] = []
    for (const shot of images.screenshots ?? []) {
      if (await check(shot, 'screenshot', read)) {
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
  for (const listed of marketplace.plugins) {
    const { entry, readBlob: read } =
      fill && budget > 0 ? await fill(listed, readBlob, budget) : { entry: listed, readBlob }
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
      const kept = await keep(images, read)
      releases.push(Object.keys(kept).length ? { ...rest, images: kept } : rest)
    }
    plugins.push({ ...entry, releases })
  }
  return { marketplace: { ...marketplace, plugins }, images: [...verified.values()] }
}

/** sha256 of bytes, remembered per buffer when a pass-spanning memo is supplied. */
export function catalogImageDigest(bytes: Uint8Array, memo: CatalogBufferMemo | undefined): string {
  let digest = memo?.digests.get(bytes)
  if (digest === undefined) {
    digest = sha256Hex(bytes)
    memo?.digests.set(bytes, digest)
  }
  return digest
}

/** Image header of bytes, remembered per buffer like its digest. */
export function catalogImageHeader(
  bytes: Uint8Array,
  memo: CatalogBufferMemo | undefined
): PluginImageInfo | string {
  let info = memo?.headers.get(bytes)
  if (info === undefined) {
    info = readPluginImageHeader(bytes)
    memo?.headers.set(bytes, info)
  }
  return info
}
