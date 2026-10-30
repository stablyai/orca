import type { PluginCapabilityKind } from '../../../shared/plugins/capabilities/plugin-capabilities'
import { PLUGIN_EVENT_PAYLOAD_SCHEMAS } from '../../../shared/plugins/events/plugin-events'
import type { PluginPanelMessage } from '../../../shared/plugins/frames/plugin-frame-bridge'
import type { PluginEventName } from '../../../shared/plugins/manifest/plugin-manifest'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'
import type { PluginHostServices } from '../workers/plugin-host-method-bindings'

export type PluginPanelMessageSink = (message: PluginPanelMessage) => boolean

export type PluginPanelMessagingOptions = {
  resolveApprovedPlugin: (pluginKey: string) => ValidDiscoveredPlugin | null
  grantedCapabilities: (pluginKey: string) => readonly PluginCapabilityKind[] | null
  /** True while some window holds a session for the panel, which can outlive its closed tab. */
  hasOpenFrame: (pluginKey: string, panelId: string) => boolean
  /** Hands a message to the desktop's own windows; false when none is open. Remote (RPC) frames are
   *  not reached yet. Null until the host binds one. */
  sink: () => PluginPanelMessageSink | null
  deliverToWorker: (
    plugin: ValidDiscoveredPlugin,
    event: PluginEventName,
    payload: unknown
  ) => Promise<void>
}

/**
 * The `panel.post` and `panel.action` handlers behind the host API. Plugin-private: a plugin can
 * only name panels its own manifest lists, and an action only reaches a worker that subscribed.
 * `delivered` means some window hosts the panel, not that a frame rendered the message.
 */
export function createPluginPanelMessaging(
  options: PluginPanelMessagingOptions
): PluginHostServices['panels'] {
  const ownPanel = (pluginKey: string, panelId: string): ValidDiscoveredPlugin => {
    const plugin = options.resolveApprovedPlugin(pluginKey)
    if (!plugin) {
      throw new Error('plugin is not enabled')
    }
    if (!plugin.manifest.contributes.panels.some((panel) => panel.id === panelId)) {
      throw new Error(`plugin has no panel ${panelId}`)
    }
    return plugin
  }
  return {
    async post(pluginKey, panelId, payload) {
      ownPanel(pluginKey, panelId)
      if (!options.hasOpenFrame(pluginKey, panelId)) {
        return { delivered: false }
      }
      const sink = options.sink()
      return { delivered: sink ? sink({ pluginKey, panelId, payload }) : false }
    },
    async action(pluginKey, panelId, action, params) {
      const plugin = ownPanel(pluginKey, panelId)
      if (!plugin.manifest.contributes.events.some((entry) => entry.on === 'panel.action')) {
        throw new Error('plugin does not subscribe to panel.action')
      }
      // Why re-check: the host-call gate already requires panel:own; this keeps the module safe if called from elsewhere.
      if (!options.grantedCapabilities(pluginKey)?.includes('panel:own')) {
        throw new Error('plugin is not granted panel:own')
      }
      // Why parse: deliverPluginEvent projects every payload through its schema; the worker sees no other shape.
      const parsed = PLUGIN_EVENT_PAYLOAD_SCHEMAS['panel.action'].safeParse({
        panelId,
        action,
        ...(params === undefined ? {} : { params })
      })
      if (!parsed.success) {
        throw new Error('panel.action payload rejected')
      }
      await options.deliverToWorker(plugin, 'panel.action', parsed.data)
    }
  }
}
