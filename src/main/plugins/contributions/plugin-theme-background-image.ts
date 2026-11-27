import { parsePluginAppThemeArtifact } from '../../../shared/plugins/artifacts/plugin-theme-artifact'
import type {
  PluginThemeBackground,
  PluginThemeBackgroundArtifact
} from '../../../shared/plugins/artifacts/plugin-theme-background'
import { pluginInstalledImageUrl } from '../../../shared/plugins/images/plugin-image-url'
import { PLUGIN_THEME_MAX_BYTES } from '../artifacts/plugin-artifact-validation'
import { readContainedPluginArtifactText } from '../artifacts/plugin-contained-artifact'
import type { ValidDiscoveredPlugin } from '../discovery/plugin-discovery'

const THEME_BACKGROUND_SLOT = /^theme-(0|[1-9]\d{0,2})(-video)?$/

/** The renderer-facing image and video. Bytes are checked when served, not here: registering every
 *  theme of every plugin would otherwise read megabytes per theme that nobody may select. */
export function resolvePluginThemeBackground(
  plugin: ValidDiscoveredPlugin,
  themeIndex: number,
  background: PluginThemeBackgroundArtifact | undefined
): PluginThemeBackground | undefined {
  const contentHash = plugin.isDev ? 'dev' : plugin.contentHash
  if (!background || !contentHash || themeIndex < 0) {
    return undefined
  }
  const url = (slot: string) => pluginInstalledImageUrl(plugin.pluginKey, contentHash, slot)
  return {
    url: url(`theme-${themeIndex}`),
    ...(background.videoPath ? { videoUrl: url(`theme-${themeIndex}-video`) } : {}),
    opacity: background.opacity,
    size: background.size,
    position: background.position
  }
}

/** The file behind a `theme-<index>` (image) or `theme-<index>-video` URL slot, re-read from the
 *  theme file on each request. */
export async function pluginThemeBackgroundFile(
  plugin: ValidDiscoveredPlugin,
  slot: string
): Promise<{ video: boolean; path: string } | null> {
  const [, index, video] = THEME_BACKGROUND_SLOT.exec(slot) ?? []
  const contribution =
    index === undefined ? undefined : plugin.manifest.contributes.themes[Number(index)]
  if (!contribution) {
    return null
  }
  const text = await readContainedPluginArtifactText(
    plugin.rootDir,
    contribution.path,
    PLUGIN_THEME_MAX_BYTES
  )
  const background = parsePluginAppThemeArtifact(text).background
  const path = video ? background?.videoPath : background?.path
  return path ? { video: video !== undefined, path } : null
}
