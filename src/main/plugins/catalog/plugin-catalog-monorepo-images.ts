import {
  isSameGitRepository,
  type PluginMarketplace
} from '../../../shared/plugins/catalog/plugin-marketplace'
import { catalogImagesFromManifest } from '../../../shared/plugins/images/plugin-manifest-catalog-images'
import { sha256Hex } from '../plugin-image-cache'
import type { CatalogBlobReader } from './plugin-catalog-image-extraction'

const MANIFEST_MAX_BYTES = 256 * 1024

/**
 * A catalog that keeps its plugins in its own repository already holds their images, so a newest
 * release listed without `images` borrows the manifest's from the catalog commit. Extraction then
 * checks those bytes like any declared image.
 */
export async function fillMonorepoReleaseImages(
  marketplace: PluginMarketplace,
  catalogUrl: string,
  readBlob: CatalogBlobReader
): Promise<PluginMarketplace> {
  const plugins: PluginMarketplace['plugins'] = []
  for (const entry of marketplace.plugins) {
    const [newest, ...older] = entry.releases ?? []
    const prefix = entry.source.path
    if (!newest || newest.images || !prefix || !isSameGitRepository(entry.source.url, catalogUrl)) {
      plugins.push(entry)
      continue
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
    const images = await catalogImagesFromManifest({
      manifest,
      prefix,
      read: readBlob,
      sha256: (bytes) => sha256Hex(Buffer.from(bytes))
    })
    plugins.push(images ? { ...entry, releases: [{ ...newest, images }, ...older] } : entry)
  }
  return { ...marketplace, plugins }
}
