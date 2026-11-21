import {
  PLUGIN_HOST_API,
  type PluginJsonValue
} from '../../../../shared/plugins/workers/plugin-host-api'
import type { PluginEventName } from '../../../../shared/plugins/manifest/plugin-manifest'
import type {
  PluginDataArea,
  PluginPanelCaller
} from '../../../../shared/plugins/workers/plugin-panel-bridge-protocol'
import { bind, type BoundPluginHostMethod } from './plugin-host-method-bind'
import { PluginHostCallError } from './plugin-host-call-scope'

/** What `plugin.request`, `events.subscribe` and data-change notices reach (PluginPanelBridge). */
export type PluginPanelBridgeServices = {
  request(
    pluginId: string,
    request: { name: string; input: unknown; timeoutMs?: number },
    caller: PluginPanelCaller
  ): Promise<PluginJsonValue>
  requestBytes(
    pluginId: string,
    request: { name: string; input: unknown; timeoutMs?: number },
    caller: PluginPanelCaller
  ): Promise<ArrayBuffer>
  subscribe(pluginId: string, panelId: string, event: PluginEventName): void
  dataChanged(pluginId: string, area: PluginDataArea, key: string): void
}

function requirePanel(caller: PluginPanelCaller | undefined): PluginPanelCaller {
  if (!caller) {
    throw new PluginHostCallError('not_permitted', 'only an open panel or editor can call this')
  }
  return caller
}

function requireBridge(
  bridge: PluginPanelBridgeServices | null | undefined
): PluginPanelBridgeServices {
  if (!bridge) {
    throw new PluginHostCallError('unavailable', 'panels cannot reach their worker in this Orca')
  }
  return bridge
}

const api = PLUGIN_HOST_API

export const PLUGIN_PANEL_BRIDGE_HANDLERS = {
  'plugin.request': bind(
    api['plugin.request'],
    async ({ name, input, timeoutMs }, { pluginId, services, scope }) => {
      const caller = requirePanel(scope.panel)
      const output = await requireBridge(services.panels).request(
        pluginId,
        { name, input: input ?? null, timeoutMs },
        caller
      )
      return { output }
    }
  ),
  'plugin.requestBytes': bind(
    api['plugin.requestBytes'],
    async ({ name, input, timeoutMs }, { pluginId, services, scope }) => {
      const caller = requirePanel(scope.panel)
      // Why before the worker runs: a paired client's JSON RPC cannot carry an ArrayBuffer.
      if (scope.callerWebContentsId === undefined) {
        throw new PluginHostCallError(
          'not_permitted',
          'this method is only available in the Orca desktop app'
        )
      }
      const bytes = await requireBridge(services.panels).requestBytes(
        pluginId,
        { name, input: input ?? null, timeoutMs },
        caller
      )
      return { bytes }
    }
  ),
  'events.subscribe': bind(
    api['events.subscribe'],
    async ({ event }, { pluginId, services, scope }) => {
      requireBridge(services.panels).subscribe(pluginId, requirePanel(scope.panel).id, event)
      return { ok: true as const }
    }
  )
} satisfies Record<string, BoundPluginHostMethod>
