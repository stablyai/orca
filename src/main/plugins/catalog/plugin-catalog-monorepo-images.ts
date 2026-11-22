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
 * release listed without `images` borrows them from its manifest at the catalog commit.
 */
export async function fillMonorepoReleaseImages(
  entry: PluginMarketplaceEntry,
  catalogUrl: string,
  readBlob: CatalogBlobReader,
  memo?: CatalogBufferMemo
): Promise<PluginMarketplaceEntry> {
  const [newest, ...older] = entry.releases ?? []
  const prefix = entry.source.path
  if (!newest || newest.images || !prefix || !isSameGitRepository(entry.source.url, catalogUrl)) {
    return entry
  }
  const manifestBytes = await readBlob(`${prefix}/orca-plugin.json`, MANIFEST_MAX_BYTES).catch(
    () => null
  )
  const manifest = manifestBytes ? parseManifest(manifestBytes, memo?.manifests) : null
  const images = await catalogImagesFromManifest({
    manifest,
    prefix,
    read: readBlob,
    sha256: (bytes) => catalogImageDigest(bytes, memo),
    readHeader: (bytes) => catalogImageHeader(bytes, memo)
  })
  return images ? { ...entry, releases: [{ ...newest, images }, ...older] } : entry
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
