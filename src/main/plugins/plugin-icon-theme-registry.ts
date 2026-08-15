import {
  parsePluginIconThemeArtifact,
  pluginIconSvgDataUrl,
  pluginIconThemeId,
  validatePluginIconSvg,
  PLUGIN_ICON_SVG_MAX_BYTES,
  PLUGIN_ICON_THEME_MANIFEST_MAX_BYTES,
  PLUGIN_ICON_THEME_TOTAL_MAX_BYTES,
  type PluginIconThemeRegistration
} from '../../shared/plugins/plugin-icon-theme-artifact'
import { readContainedPluginArtifactText } from './plugin-artifact-validation'
import type { PluginContentVerifier } from './plugin-content-integrity'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import {
  isInvalidDiscoveredPlugin,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from './plugin-discovery'

const ICON_THEME_LOAD_CONCURRENCY = 4
const ICON_READ_CONCURRENCY = 8

type IconThemeLoadResult =
  | { pluginKey: string; themes: PluginIconThemeRegistration[] }
  | { pluginKey: string; error: string }

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
    const candidates: ValidDiscoveredPlugin[] = []
    for (const plugin of discovered) {
      if (
        !isInvalidDiscoveredPlugin(plugin) &&
        isApproved(plugin) &&
        plugin.manifest.contributes.iconThemes.length > 0
      ) {
        candidates.push(plugin)
      }
    }
    const results = await mapWithConcurrency(
      candidates,
      ICON_THEME_LOAD_CONCURRENCY,
      async (plugin): Promise<IconThemeLoadResult> => {
        try {
          await this.contentVerifier.verify(plugin)
          const themes = await Promise.all(
            plugin.manifest.contributes.iconThemes.map(async (contribution) =>
              this.loadTheme(plugin, contribution)
            )
          )
          return { pluginKey: plugin.pluginKey, themes }
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

  private async loadTheme(
    plugin: ValidDiscoveredPlugin,
    contribution: { id: string; label: string; path: string }
  ): Promise<PluginIconThemeRegistration> {
    const manifestText = await readContainedPluginArtifactText(
      plugin.rootDir,
      contribution.path,
      PLUGIN_ICON_THEME_MANIFEST_MAX_BYTES
    )
    const parsed = parsePluginIconThemeArtifact(manifestText)
    if (!parsed.ok) {
      throw new Error(`icon theme "${contribution.id}" ${parsed.error}`)
    }
    const { artifact } = parsed

    const definitions = Object.entries(artifact.iconDefinitions)
    let totalBytes = 0
    const loaded = await mapWithConcurrency(
      definitions,
      ICON_READ_CONCURRENCY,
      async ([definitionId, iconPath]): Promise<[string, string]> => {
        const svg = await readContainedPluginArtifactText(
          plugin.rootDir,
          // Icon paths are theme-manifest data, so resolve them against the
          // plugin root through the same containment check as declared paths.
          iconPath,
          PLUGIN_ICON_SVG_MAX_BYTES
        ).catch((error) => {
          throw new Error(
            `icon theme "${contribution.id}" icon ${definitionId} ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        })
        const validation = validatePluginIconSvg(svg)
        if (!validation.ok) {
          throw new Error(
            `icon theme "${contribution.id}" icon ${definitionId} ${validation.error}`
          )
        }
        totalBytes += Buffer.byteLength(svg, 'utf8')
        if (totalBytes > PLUGIN_ICON_THEME_TOTAL_MAX_BYTES) {
          throw new Error(
            `icon theme "${contribution.id}" exceeds the ${PLUGIN_ICON_THEME_TOTAL_MAX_BYTES}-byte total limit`
          )
        }
        return [definitionId, pluginIconSvgDataUrl(svg)]
      }
    )

    return {
      id: pluginIconThemeId(plugin.pluginKey, contribution.id),
      pluginKey: plugin.pluginKey,
      themeId: contribution.id,
      label: contribution.label,
      icons: Object.fromEntries(loaded),
      fileExtensions: { ...artifact.fileExtensions },
      fileNames: { ...artifact.fileNames },
      defaultIcon: artifact.defaultIcon
    }
  }
}
