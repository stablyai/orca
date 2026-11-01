import type { PluginEventName } from '../../shared/plugins/manifest/plugin-manifest'
import type { PluginCapabilityKind } from '../../shared/plugins/capabilities/plugin-capabilities'
import { PLUGIN_EVENT_CAPABILITY } from '../../shared/plugins/contributions/plugin-event-contribution'
import { PLUGIN_EVENT_PAYLOAD_SCHEMAS } from '../../shared/plugins/events/plugin-events'
import {
  isInvalidDiscoveredPlugin,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from './plugin-discovery'
import type { PluginWorkerController } from './workers/plugin-worker-controller'

/** Delivers only to plugins whose manifest subscribes and whose grant covers the event's domain. */
export function deliverPluginEvent(options: {
  event: PluginEventName
  payload: unknown
  plugins: readonly DiscoveredPlugin[]
  workerController: PluginWorkerController
  isRuntimeApproved: (plugin: ValidDiscoveredPlugin) => boolean
  grantedCapabilities: (pluginKey: string) => readonly PluginCapabilityKind[] | null
  logWarning: (pluginKey: string) => (line: string) => void
}): void {
  // Why: payloads are bounded projections, so a malformed one never reaches a plugin.
  const projected = PLUGIN_EVENT_PAYLOAD_SCHEMAS[options.event].safeParse(options.payload)
  if (!projected.success) {
    return
  }
  const required = PLUGIN_EVENT_CAPABILITY[options.event]
  for (const plugin of options.plugins) {
    if (
      isInvalidDiscoveredPlugin(plugin) ||
      !plugin.manifest.main ||
      !options.isRuntimeApproved(plugin) ||
      !plugin.manifest.contributes.events.some(
        (subscription) => subscription.on === options.event
      ) ||
      !options.grantedCapabilities(plugin.pluginKey)?.includes(required)
    ) {
      continue
    }
    const logWarning = options.logWarning(plugin.pluginKey)
    void options.workerController
      .ensure(plugin)
      .then((handle) => handle.deliverEvent(options.event, projected.data))
      .catch((error) => {
        logWarning(
          `event ${options.event} dropped: ${error instanceof Error ? error.message : String(error)}`
        )
      })
  }
}
