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

/** Who made a call: the WebContents of the frame's host window, for desktop IPC calls only. */
export type PluginHostCaller = { webContentsId?: number }

type FindApprovedPlugin = (
  pluginKey: string,
  allowRefreshPause?: boolean
) => ValidDiscoveredPlugin | null

/** Admission snapshot plus a live re-check: same install, same manifest, still approved. */
export function createPluginHostCallScope(
  admitted: ValidDiscoveredPlugin,
  findApprovedPlugin: FindApprovedPlugin,
  caller: PluginHostCaller | undefined
): PluginHostCallScope {
  const manifestRevision = JSON.stringify(admitted.manifest)
  return {
    callerWebContentsId: caller?.webContentsId,
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
  audit: PluginAuditLog
}): PluginHostCallPolicy {
  const plugin = input.findApprovedPlugin(input.pluginKey)
  return {
    grantedCapabilities: plugin ? capabilityKinds(plugin.manifest.capabilities) : null,
    services: input.runtimeDelegate
      ? bindPluginHostServices({
          delegate: input.runtimeDelegate,
          pluginsDataDir: input.pluginsDataDir,
          desktop: input.desktop
        })
      : null,
    audit: input.audit,
    scope: plugin
      ? createPluginHostCallScope(plugin, input.findApprovedPlugin, input.caller)
      : undefined
  }
}
