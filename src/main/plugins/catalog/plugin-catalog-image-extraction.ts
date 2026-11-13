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
 *  ones whose bytes match their hash, size and format, and drops the rest from the listing. */
export async function extractCatalogImages(
  marketplace: PluginMarketplace,
  readBlob: CatalogBlobReader,
  fill?: CatalogEntryImageFill,
  // Why: a smaller cap keeps budget-pressure tests cheap; production always uses the catalog bound.
  options: { maxBytes?: number } = {}
): Promise<{ marketplace: PluginMarketplace; images: Buffer[] }> {
  const verified = new Map<string, Buffer>()
  const rejected = new Set<string>()
  let budget = options.maxBytes ?? CATALOG_IMAGES_MAX_BYTES
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
  const filled: { entry: PluginMarketplaceEntry; read: CatalogBlobReader }[] = []
  for (const listed of marketplace.plugins) {
    const prepared = fill ? await fill(listed, readBlob) : { entry: listed, readBlob }
    filled.push({ entry: prepared.entry, read: prepared.readBlob })
  }
  const kept: PluginCatalogImages[][] = filled.map(({ entry }) =>
    (entry.releases ?? []).map(() => ({}))
  )
  type ImageTask = {
    pluginIndex: number
    releaseIndex: number
    kind: PluginImageKind
    image: CatalogImage
    read: CatalogBlobReader
  }
  const tasks: ImageTask[] = []
  const enqueue = (
    pluginIndex: number,
    releaseIndex: number,
    kind: PluginImageKind,
    image: CatalogImage | undefined,
    read: CatalogBlobReader
  ): void => {
    if (image) {
      tasks.push({ pluginIndex, releaseIndex, kind, image, read })
    }
  }
  // Why: alphabetical order must not decide which plugins keep artwork. Identity art (icon and
  // cover) of the newest release, then of older selectable releases, goes before any screenshot.
  filled.forEach(({ entry, read }, pluginIndex) => {
    const images = entry.releases?.[0]?.images
    if (!images) {
      return
    }
    enqueue(pluginIndex, 0, 'icon', images.icon, read)
    enqueue(pluginIndex, 0, 'cover', images.cover, read)
  })
  filled.forEach(({ entry, read }, pluginIndex) => {
    const releases = entry.releases ?? []
    for (let releaseIndex = 1; releaseIndex < releases.length; releaseIndex += 1) {
      const images = releases[releaseIndex]?.images
      if (!images) {
        continue
      }
      enqueue(pluginIndex, releaseIndex, 'icon', images.icon, read)
      enqueue(pluginIndex, releaseIndex, 'cover', images.cover, read)
    }
  })
  filled.forEach(({ entry, read }, pluginIndex) => {
    for (const shot of entry.releases?.[0]?.images?.screenshots ?? []) {
      enqueue(pluginIndex, 0, 'screenshot', shot, read)
    }
  })
  filled.forEach(({ entry, read }, pluginIndex) => {
    const releases = entry.releases ?? []
    for (let releaseIndex = 1; releaseIndex < releases.length; releaseIndex += 1) {
      for (const shot of releases[releaseIndex]?.images?.screenshots ?? []) {
        enqueue(pluginIndex, releaseIndex, 'screenshot', shot, read)
      }
    }
  })
  for (const task of tasks) {
    if (!(await check(task.image, task.kind, task.read))) {
      continue
    }
    const target = kept[task.pluginIndex]![task.releaseIndex]!
    if (task.kind === 'screenshot') {
      const screenshots = (target.screenshots ??= [])
      screenshots.push(task.image)
    } else {
      target[task.kind] = task.image
    }
  }
  const plugins: PluginMarketplace['plugins'] = filled.map(({ entry }, pluginIndex) => {
    if (!entry.releases) {
      return entry
    }
    const releases: PluginCatalogRelease[] = entry.releases.map((release, releaseIndex) => {
      if (!release.images) {
        return release
      }
      const { images: _images, ...rest } = release
      const keptImages = kept[pluginIndex]![releaseIndex]!
      return Object.keys(keptImages).length > 0 ? { ...rest, images: keptImages } : rest
    })
    return { ...entry, releases }
  })
  return { marketplace: { ...marketplace, plugins }, images: [...verified.values()] }
}
