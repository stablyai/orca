import {
  parsePluginTerminalThemeArtifact,
  type PluginTerminalThemeRegistration
} from '../../shared/plugins/plugin-terminal-theme-artifact'
import {
  PLUGIN_TERMINAL_THEME_MAX_BYTES,
  readContainedPluginArtifactText
} from './plugin-artifact-validation'
import type { PluginContentVerifier } from './plugin-content-integrity'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import {
  isInvalidDiscoveredPlugin,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from './plugin-discovery'

const TERMINAL_THEME_LOAD_CONCURRENCY = 4

type TerminalThemeLoadResult =
  | { pluginKey: string; themes: PluginTerminalThemeRegistration[] }
  | { pluginKey: string; error: string }

export class PluginTerminalThemeRegistry {
  private themes: PluginTerminalThemeRegistration[] = []
  private readonly errors = new Map<string, string>()

  constructor(private readonly contentVerifier: PluginContentVerifier) {}

  list(): readonly PluginTerminalThemeRegistration[] {
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
        plugin.manifest.contributes.terminalThemes.length > 0
    )
    const results = await mapWithConcurrency(
      candidates,
      TERMINAL_THEME_LOAD_CONCURRENCY,
      async (plugin): Promise<TerminalThemeLoadResult> => {
        try {
          await this.contentVerifier.verify(plugin)
          const themes = await Promise.all(
            plugin.manifest.contributes.terminalThemes.map(async (contribution) => ({
              id: `plugin:${plugin.pluginKey}/${contribution.id}` as const,
              pluginKey: plugin.pluginKey,
              label: contribution.label,
              ...parsePluginTerminalThemeArtifact(
                await readContainedPluginArtifactText(
                  plugin.rootDir,
                  contribution.path,
                  PLUGIN_TERMINAL_THEME_MAX_BYTES
                )
              )
            }))
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
