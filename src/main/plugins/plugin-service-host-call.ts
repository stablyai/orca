import type { PluginCapabilityKind } from '../../shared/plugins/plugin-capabilities'
import type { PluginAuditLog } from './plugin-audit-log'
import { getPluginsDataDir } from './plugin-discovery'
import type { PluginEventBus } from './plugin-event-bus'
import {
  executePluginHostCallRequest,
  type PluginHostCallRequest
} from './plugin-host-call-adapter'
import { bindPluginHostServices, type PluginRuntimeDelegate } from './plugin-host-service-bindings'
import type { PluginPanelController } from './plugin-panel-controller'

/** Binds host policy for worker, panel bridge and serve RPC calls. */
export function executePluginServiceHostCall(
  pluginKey: string,
  input: {
    request: PluginHostCallRequest
    viaPanel: boolean
    getGrantedCapabilities: (pluginKey: string) => PluginCapabilityKind[] | null
    runtimeDelegate: PluginRuntimeDelegate | null
    userDataPath: string
    panels: PluginPanelController
    eventBus: PluginEventBus
    audit: PluginAuditLog
  }
) {
  return executePluginHostCallRequest({
    pluginKey,
    request: input.request,
    viaPanel: input.viaPanel,
    resolvePolicy: (boundPluginKey) => ({
      grantedCapabilities: input.getGrantedCapabilities(boundPluginKey),
      services: input.runtimeDelegate
        ? bindPluginHostServices({
            delegate: input.runtimeDelegate,
            pluginsDataDir: getPluginsDataDir(input.userDataPath),
            panelMessageAdmission: input.panels.messageAdmission,
            postPanelMessage: (key, panelId, data) => input.panels.postMessage(key, panelId, data),
            subscribeEvents: (key, events) => input.eventBus.subscribe(key, events)
          })
        : null,
      audit: input.audit
    })
  })
}
