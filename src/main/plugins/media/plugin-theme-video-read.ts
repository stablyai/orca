import {
  PLUGIN_VIDEO_MIME,
  readPluginVideoHeader
} from '../../../shared/plugins/media/plugin-video-format'
import {
  PLUGIN_THEME_VIDEO_RULE,
  pluginThemeVideoRuleError
} from '../../../shared/plugins/media/plugin-theme-video-rules'
import { readContainedPluginArtifactBytes } from '../artifacts/plugin-contained-artifact'
import type { CheckedPluginImage } from './plugin-image-read'

/** Reads a theme background video inside its plugin and re-checks it from its headers; null when
 *  it no longer fits, so the renderer keeps the theme's static image. */
export async function readCheckedPluginThemeVideo(
  rootDir: string,
  path: string
): Promise<CheckedPluginImage | null> {
  const bytes = await readContainedPluginArtifactBytes(
    rootDir,
    path,
    PLUGIN_THEME_VIDEO_RULE.maxBytes
  )
  const info = readPluginVideoHeader(bytes)
  if (typeof info === 'string' || pluginThemeVideoRuleError(info, bytes.byteLength)) {
    return null
  }
  return { bytes, mimeType: PLUGIN_VIDEO_MIME[info.container] }
}
