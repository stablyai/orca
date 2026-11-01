import {
  isSameGitRepository,
  type PluginMarketplaceEntry
} from '../../../shared/plugins/catalog/plugin-marketplace'
import { catalogImagesFromManifest } from '../../../shared/plugins/images/plugin-manifest-catalog-images'
import { sha256Hex } from '../plugin-image-cache'
import type { CatalogBlobReader } from './plugin-catalog-image-extraction'

const MANIFEST_MAX_BYTES = 256 * 1024

/**
 * A catalog that keeps its plugins in its own repository already holds their images, so a newest
 * release listed without `images` borrows the manifest's from the catalog commit. Extraction then
 * checks those bytes like any declared image, through the returned reader so they are not read twice.
 */
export async function fillMonorepoReleaseImages(
  entry: PluginMarketplaceEntry,
  catalogUrl: string,
  readBlob: CatalogBlobReader
): Promise<{ entry: PluginMarketplaceEntry; readBlob: CatalogBlobReader }> {
  const [newest, ...older] = entry.releases ?? []
  const prefix = entry.source.path
  if (!newest || newest.images || !prefix || !isSameGitRepository(entry.source.url, catalogUrl)) {
    return { entry, readBlob }
  }
  const manifestBytes = await readBlob(`${prefix}/orca-plugin.json`, MANIFEST_MAX_BYTES).catch(
    () => null
  )
  let manifest: unknown = null
  try {
    manifest = manifestBytes ? JSON.parse(manifestBytes.toString('utf8')) : null
  } catch {
    manifest = null
  }
  const read = new Map<string, Buffer>()
  const images = await catalogImagesFromManifest({
    manifest,
    prefix,
    read: async (path, maxBytes) => {
      const bytes = await readBlob(path, maxBytes)
      if (bytes) {
        read.set(path, bytes)
      }
      return bytes
    },
    sha256: (bytes) => sha256Hex(Buffer.from(bytes))
  })
  if (!images) {
    return { entry, readBlob }
  }
  return {
    entry: { ...entry, releases: [{ ...newest, images }, ...older] },
    // Why the size check: a pinned blob larger than `maxBytes` reads as null, as readBlob would.
    readBlob: async (path, maxBytes) => {
      const bytes = read.get(path)
      return bytes ? (bytes.byteLength <= maxBytes ? bytes : null) : readBlob(path, maxBytes)
    }
  }
}
