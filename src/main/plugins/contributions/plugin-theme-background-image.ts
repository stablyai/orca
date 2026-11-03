import { parsePluginAppThemeArtifact } from '../../../shared/plugins/artifacts/plugin-theme-artifact'
import type {
  PluginThemeBackground,
  PluginThemeBackgroundArtifact
} from '../../../shared/plugins/artifacts/plugin-theme-background'
import { pluginInstalledImageUrl } from '../../../shared/plugins/images/plugin-image-url'
import {
  PLUGIN_THEME_MAX_BYTES,
  readContainedPluginArtifactText
} from '../plugin-artifact-validation'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'

const THEME_BACKGROUND_SLOT = /^theme-(0|[1-9]\d{0,2})$/

/** The renderer-facing image. Bytes are checked when served, not here: registering every theme of
 *  every plugin would otherwise read up to 2 MB per theme that nobody may select. */
export function resolvePluginThemeBackground(
  plugin: ValidDiscoveredPlugin,
  themeIndex: number,
  background: PluginThemeBackgroundArtifact | undefined
): PluginThemeBackground | undefined {
  const contentHash = plugin.isDev ? 'dev' : plugin.contentHash
  if (!background || !contentHash || themeIndex < 0) {
    return undefined
  }
  return {
    url: pluginInstalledImageUrl(plugin.pluginKey, contentHash, `theme-${themeIndex}`),
    opacity: background.opacity,
    size: background.size,
    position: background.position
  }
}

/** The image path behind a `theme-<index>` URL slot, re-read from the theme file on each request. */
export async function pluginThemeBackgroundPath(
  plugin: ValidDiscoveredPlugin,
  slot: string
): Promise<string | null> {
  const index = THEME_BACKGROUND_SLOT.exec(slot)?.[1]
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
  return parsePluginAppThemeArtifact(text).background?.path ?? null
}
