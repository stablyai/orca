import type { PluginContentVerifier } from './plugin-content-integrity'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import {
  isInvalidDiscoveredPlugin,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from './plugin-discovery'

const ARTIFACT_PACK_LOAD_CONCURRENCY = 4

type ArtifactPackLoadResult<Entry> =
  | { pluginKey: string; entries: Entry[] }
  | { pluginKey: string; error: string }

/** Loads one data contribution family from verified plugin trees. A plugin whose content fails
 *  verification or parsing contributes nothing and reports one error. */
export class PluginArtifactPackRegistry<Contribution, Entry> {
  private entries: Entry[] = []
  private readonly errors = new Map<string, string>()

  constructor(
    private readonly options: {
      contentVerifier: PluginContentVerifier
      contributions: (plugin: ValidDiscoveredPlugin) => readonly Contribution[]
      load: (plugin: ValidDiscoveredPlugin, contribution: Contribution) => Promise<Entry>
    }
  ) {}

  list(): readonly Entry[] {
    return this.entries
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
        this.options.contributions(plugin).length > 0
      ) {
        candidates.push(plugin)
      }
    }
    const results = await mapWithConcurrency(
      candidates,
      ARTIFACT_PACK_LOAD_CONCURRENCY,
      async (plugin): Promise<ArtifactPackLoadResult<Entry>> => {
        try {
          await this.options.contentVerifier.verify(plugin)
          const entries = await Promise.all(
            this.options
              .contributions(plugin)
              .map((contribution) => this.options.load(plugin, contribution))
          )
          return { pluginKey: plugin.pluginKey, entries }
        } catch (error) {
          return {
            pluginKey: plugin.pluginKey,
            error: error instanceof Error ? error.message : String(error)
          }
        }
      }
    )
    this.entries = results.flatMap((result) => ('entries' in result ? result.entries : []))
    this.errors.clear()
    for (const result of results) {
      if ('error' in result) {
        this.errors.set(result.pluginKey, result.error)
      }
    }
  }
}
