import {
  parsePluginIconThemeArtifact,
  type PluginIconThemeAsset,
  type PluginIconThemeRegistration
} from '../../shared/plugins/plugin-icon-theme-artifact'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import {
  isInvalidDiscoveredPlugin,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from './plugin-discovery'
import type { PluginContentVerifier } from './plugin-content-integrity'
import {
  PLUGIN_ICON_THEME_MAX_BYTES,
  readContainedPluginArtifactText
} from './plugin-artifact-validation'

export const PLUGIN_ICON_ASSET_MAX_BYTES = 256 * 1024
export const PLUGIN_ICON_THEME_TOTAL_ASSET_BYTES = 8 * 1024 * 1024

const ICON_THEME_LOAD_CONCURRENCY = 4

type IconThemeLoadResult =
  | { pluginKey: string; themes: PluginIconThemeRegistration[] }
  | { pluginKey: string; error: string }

function svgAsset(svg: string, path: string): PluginIconThemeAsset {
  const source = svg.trimStart()
  if (
    !/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*|<!DOCTYPE\s+svg[^<>[\]]*>\s*)*<svg[\s>]/i.test(
      source
    )
  ) {
    throw new Error(`icon asset ${path} must contain an SVG document`)
  }
  return {
    src: `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`,
    monochrome: /\bcurrentColor\b/i.test(svg)
  }
}

async function loadTheme(
  plugin: ValidDiscoveredPlugin,
  contribution: ValidDiscoveredPlugin['manifest']['contributes']['iconThemes'][number]
): Promise<PluginIconThemeRegistration> {
  const raw = await readContainedPluginArtifactText(
    plugin.rootDir,
    contribution.path,
    PLUGIN_ICON_THEME_MAX_BYTES
  )
  const parsed = parsePluginIconThemeArtifact(raw)
  if (!parsed.ok) {
    throw new Error(`icon theme "${contribution.id}" ${parsed.error}`)
  }

  let totalBytes = 0
  const assets: Record<string, PluginIconThemeAsset> = {}
  for (const path of parsed.assetPaths) {
    const svg = await readContainedPluginArtifactText(
      plugin.rootDir,
      path,
      PLUGIN_ICON_ASSET_MAX_BYTES
    )
    totalBytes += Buffer.byteLength(svg, 'utf8')
    if (totalBytes > PLUGIN_ICON_THEME_TOTAL_ASSET_BYTES) {
      throw new Error(
        `icon theme "${contribution.id}" exceeds the ${PLUGIN_ICON_THEME_TOTAL_ASSET_BYTES}-byte asset limit`
      )
    }
    assets[path] = svgAsset(svg, path)
  }

  return {
    id: `plugin:${plugin.pluginKey}/${contribution.id}`,
    pluginKey: plugin.pluginKey,
    themeId: contribution.id,
    label: contribution.label,
    theme: parsed.theme,
    assets
  }
}

export class PluginIconThemeRegistry {
  private themes: PluginIconThemeRegistration[] = []
  private readonly errors = new Map<string, string>()

  constructor(private readonly contentVerifier: PluginContentVerifier) {}

  list(): readonly PluginIconThemeRegistration[] {
    return this.themes
  }

  error(pluginKey: string): string | null {
    return this.errors.get(pluginKey) ?? null
  }

  async reconcile(
    discovered: readonly DiscoveredPlugin[],
    isApproved: (plugin: ValidDiscoveredPlugin) => boolean
  ): Promise<void> {
    const candidates = discovered.filter(
      (plugin): plugin is ValidDiscoveredPlugin =>
        !isInvalidDiscoveredPlugin(plugin) &&
        isApproved(plugin) &&
        plugin.manifest.contributes.iconThemes.length > 0
    )
    const results = await mapWithConcurrency(
      candidates,
      ICON_THEME_LOAD_CONCURRENCY,
      async (plugin): Promise<IconThemeLoadResult> => {
        try {
          await this.contentVerifier.verify(plugin)
          return {
            pluginKey: plugin.pluginKey,
            themes: await Promise.all(
              plugin.manifest.contributes.iconThemes.map((contribution) =>
                loadTheme(plugin, contribution)
              )
            )
          }
        } catch (error) {
          return {
            pluginKey: plugin.pluginKey,
            error: error instanceof Error ? error.message : String(error)
          }
        }
      }
    )

    this.themes = results.flatMap((result) => ('themes' in result ? result.themes : []))
    this.errors.clear()
    for (const result of results) {
      if ('error' in result) {
        this.errors.set(result.pluginKey, result.error)
      }
    }
  }
}
