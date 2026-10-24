import type { PluginManifest } from '../../shared/plugins/manifest/plugin-manifest'
import { readPluginImageHeader } from '../../shared/plugins/plugin-image-format'
import {
  PLUGIN_IMAGE_RULES,
  PLUGIN_IMAGES_TOTAL_MAX_BYTES,
  pluginImageRuleError,
  type PluginImageKind
} from '../../shared/plugins/plugin-image-fields'

/** The images a format 2 manifest declares, with the rules each must meet. */
export function declaredPluginImages(
  manifest: PluginManifest
): { kind: PluginImageKind; path: string }[] {
  if (manifest.manifestVersion !== 2) {
    // Why: format 1 never limited image formats, and shipped plugins must keep loading.
    return []
  }
  return [
    ...(manifest.icon ? [{ kind: 'icon' as const, path: manifest.icon }] : []),
    ...(manifest.cover ? [{ kind: 'cover' as const, path: manifest.cover.path }] : []),
    ...(manifest.screenshots ?? []).map((shot) => ({
      kind: 'screenshot' as const,
      path: shot.path
    }))
  ]
}

/** Checks each declared image by its header at the install boundary; nothing is decoded. */
// Why the reader is passed in: the artifact validator owns contained reads and calls this module.
export async function validatePluginImageArtifacts(
  rootDir: string,
  manifest: PluginManifest,
  readContainedBytes: (rootDir: string, path: string, maxBytes: number) => Promise<Buffer>
): Promise<{ ok: true } | { ok: false; error: string }> {
  let total = 0
  for (const image of declaredPluginImages(manifest)) {
    try {
      const bytes = await readContainedBytes(
        rootDir,
        image.path,
        PLUGIN_IMAGE_RULES[image.kind].maxBytes
      )
      total += bytes.byteLength
      const info = readPluginImageHeader(bytes)
      const error =
        typeof info === 'string' ? info : pluginImageRuleError(image.kind, info, bytes.byteLength)
      if (error) {
        throw new Error(error)
      }
    } catch (error) {
      return {
        ok: false,
        error: `${image.kind} ${image.path}: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }
  if (total > PLUGIN_IMAGES_TOTAL_MAX_BYTES) {
    return {
      ok: false,
      error: `images total more than ${PLUGIN_IMAGES_TOTAL_MAX_BYTES / 1024 / 1024} MB`
    }
  }
  return { ok: true }
}
