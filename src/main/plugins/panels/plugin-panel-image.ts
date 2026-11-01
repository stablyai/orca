import { z } from 'zod'
import { isPluginDeclarativeImagePath } from '../../../shared/plugins/declarative/plugin-declarative-content-props'
import {
  PLUGIN_IMAGE_MIME,
  readPluginImageHeader
} from '../../../shared/plugins/images/plugin-image-format'
import { readContainedPluginArtifactBytes } from '../plugin-artifact-validation'

/** One `Image` (or Markdown image) file; larger images belong in the plugin's own HTML panels. */
export const PLUGIN_PANEL_IMAGE_MAX_BYTES = 8 * 1024 * 1024

export const pluginPanelImageRequestSchema = z
  .object({
    sessionToken: z.string().min(1).max(256),
    path: z.string().max(512).refine(isPluginDeclarativeImagePath)
  })
  .strict()

export type PluginPanelImage = { contentType: string; bytes: Uint8Array }

/**
 * Bytes of an image file inside the plugin behind a live components-panel session, read with the
 * same containment rules as the plugin's frame assets and the same header check as its declared
 * images (a static PNG, JPEG or WebP within bounds, judged before any decoder runs). Null for
 * anything else: the renderer never loads a panel image from anywhere but here.
 */
export async function readPluginPanelImage(
  dependencies: { resolveComponentsPanelRoot: (sessionToken: string) => string | null },
  args: unknown
): Promise<PluginPanelImage | null> {
  const parsed = pluginPanelImageRequestSchema.safeParse(args)
  if (!parsed.success) {
    return null
  }
  const rootDir = dependencies.resolveComponentsPanelRoot(parsed.data.sessionToken)
  if (!rootDir) {
    return null
  }
  try {
    const bytes = await readContainedPluginArtifactBytes(
      rootDir,
      parsed.data.path,
      PLUGIN_PANEL_IMAGE_MAX_BYTES
    )
    const info = readPluginImageHeader(bytes)
    return typeof info === 'string'
      ? null
      : { contentType: PLUGIN_IMAGE_MIME[info.format], bytes: new Uint8Array(bytes) }
  } catch {
    return null
  }
}
