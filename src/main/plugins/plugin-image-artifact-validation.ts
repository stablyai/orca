import type { PluginManifest } from '../../shared/plugins/manifest/plugin-manifest'
import { readPluginImageHeader } from '../../shared/plugins/images/plugin-image-format'
import {
  PLUGIN_IMAGE_RULES,
  PLUGIN_IMAGES_TOTAL_MAX_BYTES,
  pluginImageRuleError,
  type PluginImageKind
} from '../../shared/plugins/images/plugin-image-fields'

/** The images a format 2 manifest declares, each with the URL slot it is served under and the
 *  rules it must meet. Editor and new-file icons follow the plugin icon's rules. */
export function declaredPluginImages(
  manifest: PluginManifest
): { kind: PluginImageKind; path: string; slot: string }[] {
  if (manifest.manifestVersion !== 2) {
    // Why: format 1 never limited image formats, and shipped plugins must keep loading.
    return []
  }
  const icon = (slot: string, path: string | undefined) =>
    path === undefined ? [] : [{ kind: 'icon' as const, path, slot }]
  return [
    ...icon('icon', manifest.icon),
    ...(manifest.cover
      ? [{ kind: 'cover' as const, path: manifest.cover.path, slot: 'cover' }]
      : []),
    ...(manifest.screenshots ?? []).map((shot, index) => ({
      kind: 'screenshot' as const,
      path: shot.path,
      slot: `screenshot-${index}`
    })),
    ...manifest.contributes.customEditors.flatMap((editor, index) =>
      icon(`editor-${index}`, editor.icon)
    ),
    ...manifest.contributes.newFiles.flatMap((newFile, index) =>
      icon(`new-file-${index}`, newFile.icon)
    )
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
