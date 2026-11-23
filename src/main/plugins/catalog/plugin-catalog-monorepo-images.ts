import {
  isSameGitRepository,
  type PluginMarketplaceEntry
} from '../../../shared/plugins/catalog/plugin-marketplace'
import { catalogImagesFromManifest } from '../../../shared/plugins/images/plugin-manifest-catalog-images'
import {
  catalogImageDigest,
  catalogImageHeader,
  type CatalogBlobReader,
  type CatalogBufferMemo
} from './plugin-catalog-image-extraction'

const MANIFEST_MAX_BYTES = 256 * 1024

/**
 * A catalog that keeps its plugins in its own repository already holds their images, so a newest
 * release listed without `images` borrows the manifest's from the catalog commit. Extraction then
 * checks those bytes like any declared image, through the returned reader so they are not read twice.
 */
export async function fillMonorepoReleaseImages(
  entry: PluginMarketplaceEntry,
  catalogUrl: string,
  readBlob: CatalogBlobReader,
  memo?: CatalogBufferMemo
): Promise<{ entry: PluginMarketplaceEntry; readBlob: CatalogBlobReader }> {
  const [newest, ...older] = entry.releases ?? []
  const prefix = entry.source.path
  if (!newest || newest.images || !prefix || !isSameGitRepository(entry.source.url, catalogUrl)) {
    return { entry, readBlob }
  }
  const manifestBytes = await readBlob(`${prefix}/orca-plugin.json`, MANIFEST_MAX_BYTES).catch(
    () => null
  )
  const manifest = manifestBytes ? parseManifest(manifestBytes, memo?.manifests) : null
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
    sha256: (bytes) => catalogImageDigest(bytes, memo),
    readHeader: (bytes) => catalogImageHeader(bytes, memo)
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

/** Batched catalog reads rerun extraction over the same buffers; parse each manifest once. */
function parseManifest(bytes: Buffer, manifests?: WeakMap<Uint8Array, unknown>): unknown {
  if (manifests?.has(bytes)) {
    return manifests.get(bytes)
  }
  let manifest: unknown = null
  try {
    manifest = JSON.parse(bytes.toString('utf8'))
  } catch {
    manifest = null
  }
  manifests?.set(bytes, manifest)
  return manifest
}
