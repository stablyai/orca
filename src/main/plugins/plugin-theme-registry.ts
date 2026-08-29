import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import type { Buffer } from 'node:buffer'
import {
  parsePluginAppThemeArtifact,
  type PluginThemeRegistration
} from '../../shared/plugins/plugin-theme-artifact'
import {
  PLUGIN_THEME_MAX_BYTES,
  PLUGIN_THEME_TEXTURE_TOTAL_MAX_BYTES,
  readContainedPluginArtifactText,
  readContainedPluginThemeTexture
} from './plugin-artifact-validation'
import type { PluginContentVerifier } from './plugin-content-integrity'
import {
  isInvalidDiscoveredPlugin,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from './plugin-discovery'

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
    const candidates = discovered.filter(
      (plugin): plugin is ValidDiscoveredPlugin =>
        !isInvalidDiscoveredPlugin(plugin) &&
        isApproved(plugin) &&
        plugin.manifest.contributes.themes.length > 0
    )
    const results = await mapWithConcurrency(
      candidates,
      THEME_LOAD_CONCURRENCY,
      async (plugin): Promise<ThemeLoadResult> => {
        try {
          await this.contentVerifier.verify(plugin)
          const themes = await Promise.all(
            plugin.manifest.contributes.themes.map(async (contribution) => {
              const parsed = parsePluginAppThemeArtifact(
                await readContainedPluginArtifactText(
                  plugin.rootDir,
                  contribution.path,
                  PLUGIN_THEME_MAX_BYTES
                )
              )
              if (!parsed.ok) {
                throw new Error(`theme "${contribution.id}" ${parsed.error}`)
              }
              const { terminalThemeContributionId, textureAssets, ...theme } = parsed.theme
              const terminalThemeId = terminalThemeContributionId
                ? plugin.manifest.contributes.terminalThemes.some(
                    (terminalTheme) => terminalTheme.id === terminalThemeContributionId
                  )
                  ? (`plugin:${plugin.pluginKey}/${terminalThemeContributionId}` as const)
                  : null
                : undefined
              if (terminalThemeId === null) {
                throw new Error(
                  `theme "${contribution.id}" links undeclared terminal theme "${terminalThemeContributionId}"`
                )
              }
              const textureDataUrls: Record<string, string> = {}
              const loaded = new Map<string, Buffer>()
              let totalBytes = 0
              for (const [token, path] of Object.entries(textureAssets ?? {})) {
                let bytes = loaded.get(path)
                if (!bytes) {
                  bytes = await readContainedPluginThemeTexture(plugin.rootDir, path)
                  totalBytes += bytes.byteLength
                  if (totalBytes > PLUGIN_THEME_TEXTURE_TOTAL_MAX_BYTES) {
                    throw new Error(
                      `theme "${contribution.id}" textures exceed ${PLUGIN_THEME_TEXTURE_TOTAL_MAX_BYTES} bytes in total`
                    )
                  }
                  loaded.set(path, bytes)
                }
                textureDataUrls[token] = `data:image/png;base64,${bytes.toString('base64')}`
              }
              return {
                id: `plugin:${plugin.pluginKey}/${contribution.id}` as const,
                pluginKey: plugin.pluginKey,
                contributionId: contribution.id,
                label: contribution.label,
                ...theme,
                ...(terminalThemeId ? { terminalThemeId } : {}),
                ...(Object.keys(textureDataUrls).length > 0 ? { textureDataUrls } : {})
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
