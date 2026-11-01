import { capabilityKinds } from '../../shared/plugins/capabilities/plugin-capabilities'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import type { PluginAuditLog } from './plugin-audit-log'
import type { PluginHostCallPolicy } from './workers/plugin-host-call-adapter'
import {
  bindPluginHostServices,
  type PluginRuntimeDelegate
} from './workers/plugin-host-service-bindings'
import type { PluginDesktopFrameServices } from './workers/plugin-host-method-bindings'
import { pluginHostCallRevoked, type PluginHostCallScope } from './workers/plugin-host-call-scope'
import type { PluginPanelCaller } from '../../shared/plugins/workers/plugin-panel-bridge-protocol'
import type { PluginPanelBridgeServices } from './workers/plugin-host-panel-method-bindings'
import type { PluginPanelBridge } from './panels/plugin-panel-bridge'
import type {
  PluginHostCallOutcome,
  PluginSurface
} from '../../shared/plugins/frames/plugin-protocol'
import { executePluginHostCallRequest } from './workers/plugin-host-call-adapter'

/** Who made a call: the open panel (frames only), and its host window's WebContents for desktop
 *  IPC calls. */
export type PluginHostCaller = { webContentsId?: number; panel?: PluginPanelCaller }

type FindApprovedPlugin = (
  pluginKey: string,
  allowRefreshPause?: boolean
) => ValidDiscoveredPlugin | null

/** Admission snapshot plus a live re-check: same install, same manifest, still approved. */
export function createPluginHostCallScope(
  admitted: ValidDiscoveredPlugin,
  findApprovedPlugin: FindApprovedPlugin,
  caller: PluginHostCaller | undefined,
  log?: (line: string) => void
): PluginHostCallScope {
  const manifestRevision = JSON.stringify(admitted.manifest)
  return {
    callerWebContentsId: caller?.webContentsId,
    log,
    panel: caller?.panel,
    pluginName: admitted.manifest.name,
    assertActive() {
      // A refresh in flight is not a revocation; disable, consent, kill list and removal are.
      const current = findApprovedPlugin(admitted.pluginKey, true)
      if (
        !current ||
        current.rootDir !== admitted.rootDir ||
        JSON.stringify(current.manifest) !== manifestRevision
      ) {
        throw pluginHostCallRevoked()
      }
    }
  }
}

export function resolvePluginServiceHostCallPolicy(input: {
  pluginKey: string
  caller: PluginHostCaller | undefined
  findApprovedPlugin: FindApprovedPlugin
  runtimeDelegate: PluginRuntimeDelegate | null
  pluginsDataDir: string
  desktop: PluginDesktopFrameServices | null | undefined
  panels: PluginPanelBridgeServices | null
  audit: PluginAuditLog
  log?: (pluginKey: string) => (line: string) => void
}): PluginHostCallPolicy {
  const plugin = input.findApprovedPlugin(input.pluginKey)
  return {
    grantedCapabilities: plugin ? capabilityKinds(plugin.manifest.capabilities) : null,
    services: input.runtimeDelegate
      ? bindPluginHostServices({
          delegate: input.runtimeDelegate,
          pluginsDataDir: input.pluginsDataDir,
          desktop: input.desktop,
          panels: input.panels,
          declaredSettings: plugin?.manifest.contributes.settings
        })
      : null,
    audit: input.audit,
    scope: plugin
      ? createPluginHostCallScope(
          plugin,
          input.findApprovedPlugin,
          input.caller,
          input.log?.(plugin.pluginKey)
        )
      : undefined
  }
}

/** The bridge as host services: the request carries the calling panel. */
export function pluginPanelBridgeServices(bridge: PluginPanelBridge): PluginPanelBridgeServices {
  return {
    request: (pluginKey, request, caller) => bridge.request({ pluginKey, caller, ...request }),
    subscribe: (pluginKey, panelId, event) => bridge.subscribe(pluginKey, panelId, event),
    dataChanged: (pluginKey, area, key) => bridge.dataChanged(pluginKey, area, key)
  }
}

export type PluginServiceHostCall = (
  pluginKey: string,
  method: string,
  params: unknown,
  surface: PluginSurface,
  caller?: PluginHostCaller
) => Promise<PluginHostCallOutcome>

/** PluginService's one host-call entry: authenticate the request, then bind policy per call. */
export function createPluginServiceHostCall(
  policy: (pluginKey: string, caller: PluginHostCaller | undefined) => PluginHostCallPolicy
): PluginServiceHostCall {
  return (pluginKey, method, params, surface, caller) =>
    executePluginHostCallRequest({
      pluginKey,
      request: { method, params },
      surface,
      resolvePolicy: (boundPluginKey) => policy(boundPluginKey, caller)
    })
}
