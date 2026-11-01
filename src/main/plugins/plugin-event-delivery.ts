import type { PluginEventName } from '../../shared/plugins/manifest/plugin-manifest'
import type { PluginCapabilityKind } from '../../shared/plugins/capabilities/plugin-capabilities'
import { PLUGIN_EVENT_CAPABILITY } from '../../shared/plugins/contributions/plugin-event-contribution'
import { PLUGIN_EVENT_PAYLOAD_SCHEMAS } from '../../shared/plugins/events/plugin-events'
import {
  isInvalidDiscoveredPlugin,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from './plugin-discovery'
import type { PluginWorkerHandle } from './workers/plugin-host-process'

/** Whether an approved worker subscribes to `event` (open panels are asked separately). */
export function pluginWorkersWantEvent(
  event: PluginEventName,
  plugins: readonly DiscoveredPlugin[],
  isRuntimeApproved: (plugin: ValidDiscoveredPlugin) => boolean
): boolean {
  return plugins.some(
    (plugin) =>
      !isInvalidDiscoveredPlugin(plugin) &&
      plugin.manifest.main !== undefined &&
      plugin.manifest.contributes.events.some((subscription) => subscription.on === event) &&
      isRuntimeApproved(plugin)
  )
}

export type PluginEventDeliveryContext = {
  plugins: () => readonly DiscoveredPlugin[]
  ensureWorker: (plugin: ValidDiscoveredPlugin) => Promise<PluginWorkerHandle>
  isRuntimeApproved: (plugin: ValidDiscoveredPlugin) => boolean
  grantedCapabilities: (pluginKey: string) => readonly PluginCapabilityKind[] | null
  logWarning: (pluginKey: string) => (line: string) => void
}

/** Why a plugin does not receive an event; the dev emit command reports it instead of skipping. */
export type PluginEventSkipReason =
  | 'invalid'
  | 'no-worker'
  | 'not-approved'
  | 'not-subscribed'
  | 'not-granted'

export function pluginEventSkipReason(
  plugin: DiscoveredPlugin,
  event: PluginEventName,
  context: Pick<PluginEventDeliveryContext, 'isRuntimeApproved' | 'grantedCapabilities'>
): PluginEventSkipReason | null {
  if (isInvalidDiscoveredPlugin(plugin)) {
    return 'invalid'
  }
  if (!plugin.manifest.main) {
    return 'no-worker'
  }
  if (!context.isRuntimeApproved(plugin)) {
    return 'not-approved'
  }
  if (!plugin.manifest.contributes.events.some((subscription) => subscription.on === event)) {
    return 'not-subscribed'
  }
  if (!context.grantedCapabilities(plugin.pluginKey)?.includes(PLUGIN_EVENT_CAPABILITY[event])) {
    return 'not-granted'
  }
  return null
}

/** Starts the worker if needed (activation on event), then hands it an already projected payload. */
export async function deliverPluginEventToWorker(
  plugin: ValidDiscoveredPlugin,
  event: PluginEventName,
  projectedPayload: unknown,
  context: Pick<PluginEventDeliveryContext, 'ensureWorker'>
): Promise<void> {
  const handle = await context.ensureWorker(plugin)
  handle.deliverEvent(event, projectedPayload)
}

/** Delivers only to plugins whose manifest subscribes and whose grant covers the event's domain. */
export function deliverPluginEvent(
  options: { event: PluginEventName; payload: unknown } & PluginEventDeliveryContext
): void {
  // Why: payloads are bounded projections, so a malformed one never reaches a plugin.
  const projected = PLUGIN_EVENT_PAYLOAD_SCHEMAS[options.event].safeParse(options.payload)
  if (!projected.success) {
    return
  }
  for (const plugin of options.plugins()) {
    if (
      isInvalidDiscoveredPlugin(plugin) ||
      pluginEventSkipReason(plugin, options.event, options)
    ) {
      continue
    }
    const logWarning = options.logWarning(plugin.pluginKey)
    void deliverPluginEventToWorker(plugin, options.event, projected.data, options).catch(
      (error) => {
        logWarning(
          `event ${options.event} dropped: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    )
  }
}
