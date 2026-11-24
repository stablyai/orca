import type { PluginManifest } from '../../../../shared/plugins/manifest/plugin-manifest'
import {
  isInvalidDiscoveredPlugin,
  type ValidDiscoveredPlugin
} from '../../discovery/plugin-discovery'
import type { PluginEventDeliveryContext } from '../../events/plugin-event-delivery'
import type { PluginService } from '../../plugin-service'

/** A plugin whose worker runs for as long as the plugin is enabled: hooks must answer at once,
 *  and status bar items are kept current by a worker no event ever wakes. */
export function pluginNeedsResidentWorker(manifest: PluginManifest): boolean {
  return (
    manifest.main !== undefined &&
    (manifest.contributes.hooks.length > 0 || manifest.contributes.statusBarItems.length > 0)
  )
}

/** What makes a plugin the one the person approved: a change means a new revision. */
export function pluginApprovedRevision(plugin: ValidDiscoveredPlugin): string {
  return [
    plugin.consentFingerprint,
    plugin.contentHash ?? '',
    plugin.devRevision ?? '',
    plugin.rootDir
  ].join('\n')
}

export type PluginResidentWorkerContext = Pick<
  PluginEventDeliveryContext,
  'plugins' | 'isRuntimeApproved' | 'ensureWorker'
> & { isEnabled: () => boolean }

/**
 * Starts the workers of enabled plugins that need a resident worker, so the first hooked action
 * never waits on (or slips past) a cold start and status bar items update without an event. Once
 * per approved revision: crash restarts follow the worker manager's own policy, and a worker it
 * marked errored stays down until the plugin changes.
 */
export function createPluginResidentWorkerWarmer(context: PluginResidentWorkerContext): () => void {
  const warmed = new Map<string, string>()
  return () => {
    const resident = context.isEnabled()
      ? context
          .plugins()
          .filter(
            (plugin): plugin is ValidDiscoveredPlugin =>
              !isInvalidDiscoveredPlugin(plugin) &&
              pluginNeedsResidentWorker(plugin.manifest) &&
              context.isRuntimeApproved(plugin)
          )
      : []
    const keys = new Set(resident.map((plugin) => plugin.pluginKey))
    for (const pluginKey of warmed.keys()) {
      if (!keys.has(pluginKey)) {
        warmed.delete(pluginKey)
      }
    }
    for (const plugin of resident) {
      const revision = pluginApprovedRevision(plugin)
      if (warmed.get(plugin.pluginKey) === revision) {
        continue
      }
      warmed.set(plugin.pluginKey, revision)
      // Why swallow: ensure records the activation error the plugin page shows.
      void context.ensureWorker(plugin).catch(() => undefined)
    }
  }
}

/** Keeps resident workers started as plugins change. */
export function installPluginResidentWorkerWarmer(
  service: Pick<PluginService, 'eventDelivery' | 'options' | 'onChanged'>
): void {
  service.onChanged(
    createPluginResidentWorkerWarmer({
      ...service.eventDelivery,
      isEnabled: () => service.options.isPluginSystemEnabled()
    })
  )
}
