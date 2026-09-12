import {
  parsePluginLanguagePackArtifact,
  pluginLanguageResourceId,
  type PluginLanguagePackRegistration
} from '../../shared/plugins/plugin-language-pack-artifact'
import {
  PLUGIN_LANGUAGE_PACK_MAX_BYTES,
  readContainedPluginArtifactText
} from './plugin-artifact-validation'
import type { PluginContentVerifier } from './plugin-content-integrity'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import {
  isInvalidDiscoveredPlugin,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from './plugin-discovery'

const LANGUAGE_PACK_LOAD_CONCURRENCY = 4

type LanguageLoadResult =
  | { pluginKey: string; packs: PluginLanguagePackRegistration[] }
  | { pluginKey: string; error: string }

export class PluginLanguagePackRegistry {
  private packs: PluginLanguagePackRegistration[] = []
  private readonly errors = new Map<string, string>()

  constructor(private readonly contentVerifier: PluginContentVerifier) {}

  list(): readonly PluginLanguagePackRegistration[] {
    return this.packs
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
        plugin.manifest.contributes.languagePacks.length > 0
      ) {
        candidates.push(plugin)
      }
    }
    const results = await mapWithConcurrency(
      candidates,
      LANGUAGE_PACK_LOAD_CONCURRENCY,
      async (plugin): Promise<LanguageLoadResult> => {
        try {
          await this.contentVerifier.verify(plugin)
          const packs = await Promise.all(
            plugin.manifest.contributes.languagePacks.map(async (contribution) => {
              const text = await readContainedPluginArtifactText(
                plugin.rootDir,
                contribution.path,
                PLUGIN_LANGUAGE_PACK_MAX_BYTES
              )
              const parsed = parsePluginLanguagePackArtifact(text)
              if (!parsed.ok) {
                throw new Error(`language pack "${contribution.locale}" ${parsed.error}`)
              }
              const id = `plugin:${plugin.pluginKey}/${contribution.locale}` as const
              return {
                id,
                resourceLanguage: pluginLanguageResourceId(id),
                pluginKey: plugin.pluginKey,
                locale: contribution.locale,
                catalog: parsed.catalog
              }
            })
          )
          return { pluginKey: plugin.pluginKey, packs }
        } catch (error) {
          return {
            pluginKey: plugin.pluginKey,
            error: error instanceof Error ? error.message : String(error)
          }
        }
      }
    )
    this.packs = results.flatMap((result) => ('packs' in result ? result.packs : []))
    this.errors.clear()
    for (const result of results) {
      if ('error' in result) {
        this.errors.set(result.pluginKey, result.error)
      }
    }
  }
}
