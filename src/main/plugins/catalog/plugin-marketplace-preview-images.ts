import type { PluginManifest } from '../../../shared/plugins/manifest/plugin-manifest'
import type { PluginImageCache } from '../media/plugin-image-cache'
import { PLUGIN_IMAGE_RULES } from '../../../shared/plugins/images/plugin-image-fields'
import {
  pluginShaImageUrl,
  type PluginHostImages
} from '../../../shared/plugins/images/plugin-image-url'
import { readContainedPluginArtifactBytes } from '../artifacts/plugin-contained-artifact'
import { declaredPluginImages } from '../media/plugin-image-artifact-validation'
import { pluginManifestHostImages } from '../media/plugin-manifest-images'

/** Why cache now: the staging tree is deleted after preview, and images were already checked by
 *  the install inspection, so their hashes are the only stable names. */
export async function cachePluginPreviewImages(
  cache: PluginImageCache | null,
  rootDir: string,
  manifest: PluginManifest
): Promise<PluginHostImages | undefined> {
  if (!cache) {
    return undefined
  }
  const hashes = new Map<string, string>()
  for (const image of declaredPluginImages(manifest)) {
    const bytes = await readContainedPluginArtifactBytes(
      rootDir,
      image.path,
      PLUGIN_IMAGE_RULES[image.kind].maxBytes
    ).catch(() => null)
    // A cache failure only costs the image; it must never fail the preview or update.
    const sha256 = bytes
      ? await cache.put(bytes).catch((error: unknown) => {
          console.warn(`[plugins] could not cache image ${image.path}:`, error)
          return null
        })
      : null
    if (sha256) {
      hashes.set(image.path, sha256)
    }
  }
  return pluginManifestHostImages(manifest, (_slot, path) => {
    const sha256 = hashes.get(path)
    return sha256 ? pluginShaImageUrl(sha256) : null
  })
}
