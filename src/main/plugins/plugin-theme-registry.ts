import type { PluginThemeRegistration } from '../../shared/plugins/plugin-theme-artifact'
import { parsePluginAppThemeArtifact } from '../../shared/plugins/plugin-theme-artifact'
import {
  isInvalidDiscoveredPlugin,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from './plugin-discovery'
import {
  PLUGIN_THEME_MAX_BYTES,
  readContainedPluginArtifactText
} from './plugin-artifact-validation'
import type { PluginContentVerifier } from './plugin-content-integrity'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'

const THEME_LOAD_CONCURRENCY = 4

type ThemeLoadResult =
  | { pluginKey: string; themes: PluginThemeRegistration[] }
  | { pluginKey: string; error: string }

export class PluginThemeRegistry {
  private themes: PluginThemeRegistration[] = []
  private readonly errors = new Map<string, string>()

  constructor(private readonly contentVerifier: PluginContentVerifier) {}

  list(): readonly PluginThemeRegistration[] {
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
        plugin.manifest.contributes.themes.length > 0
      ) {
        candidates.push(plugin)
      }
    }
    const results = await mapWithConcurrency(
      candidates,
      THEME_LOAD_CONCURRENCY,
      async (plugin): Promise<ThemeLoadResult> => {
        try {
          await this.contentVerifier.verify(plugin)
          const themes = await Promise.all(
            plugin.manifest.contributes.themes.map(async (contribution) => {
              const text = await readContainedPluginArtifactText(
                plugin.rootDir,
                contribution.path,
                PLUGIN_THEME_MAX_BYTES
              )
              const parsed = parsePluginAppThemeArtifact(text)
              if (!parsed.ok) {
                throw new Error(`theme "${contribution.id}" ${parsed.error}`)
              }
              return {
                id: `plugin:${plugin.pluginKey}/${contribution.id}` as const,
                pluginKey: plugin.pluginKey,
                contributionId: contribution.id,
                label: contribution.label,
                ...parsed.theme
              }
            })
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
}
