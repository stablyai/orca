import {
  isInvalidDiscoveredPlugin,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from './plugin-discovery'

export type PluginTaskSourceRegistration = {
  pluginKey: string
  sourceId: string
  title: string
  icon: string | null
}

/** Active task sources of approved plugins. Rebuilt wholesale on reconcile so
 *  a revoked consent cannot leave a source addressable. */
export class PluginTaskSourceRegistry {
  private active: PluginTaskSourceRegistration[] = []

  list(): readonly PluginTaskSourceRegistration[] {
    return this.active
  }

  find(pluginKey: string, sourceId: string): PluginTaskSourceRegistration | null {
    return (
      this.active.find(
        (entry) => entry.pluginKey === pluginKey && entry.sourceId === sourceId
      ) ?? null
    )
  }

  reconcile(
    discovered: readonly DiscoveredPlugin[],
    isApproved: (plugin: ValidDiscoveredPlugin) => boolean
  ): void {
    this.active = discovered
      .filter((plugin): plugin is ValidDiscoveredPlugin => !isInvalidDiscoveredPlugin(plugin))
      .filter((plugin) => isApproved(plugin))
      .flatMap((plugin) =>
        plugin.manifest.contributes.taskSources.map((contribution) => ({
          pluginKey: plugin.pluginKey,
          sourceId: contribution.id,
          title: contribution.title,
          icon: contribution.icon ?? null
        }))
      )
  }
}
