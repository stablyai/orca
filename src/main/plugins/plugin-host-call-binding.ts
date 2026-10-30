import type { PluginCapabilityKind } from '../../shared/plugins/capabilities/plugin-capabilities'
import type {
  PluginHostCallOutcome,
  PluginSurface
} from '../../shared/plugins/frames/plugin-protocol'
import type { PluginEventName } from '../../shared/plugins/manifest/plugin-manifest'
import type { PluginAuditLog } from './plugin-audit-log'
import { getPluginsDataDir, type ValidDiscoveredPlugin } from './plugin-discovery'
import {
  createPluginPanelMessaging,
  type PluginPanelMessageSink
} from './panels/plugin-panel-messaging'
import { executePluginHostCallRequest } from './workers/plugin-host-call-adapter'
import type { PluginHostServices } from './workers/plugin-host-method-bindings'
import {
  bindPluginHostServices,
  type PluginRuntimeDelegate
} from './workers/plugin-host-service-bindings'

export type PluginHostCallBindingOptions = {
  userDataPath: string
  audit: PluginAuditLog
  resolveApprovedPlugin: (pluginKey: string) => ValidDiscoveredPlugin | null
  grantedCapabilities: (pluginKey: string) => PluginCapabilityKind[] | null
  hasOpenFrame: (pluginKey: string, panelId: string) => boolean
  deliverToWorker: (
    plugin: ValidDiscoveredPlugin,
    event: PluginEventName,
    payload: unknown
  ) => Promise<void>
}

/** Host-call seam: the desktop-bound runtime delegate and panel sink, resolved per call. */
export class PluginHostCallBinding {
  private runtimeDelegate: PluginRuntimeDelegate | null = null
  private panelMessageSink: PluginPanelMessageSink | null = null
  private readonly panelMessaging: PluginHostServices['panels']

  constructor(private readonly options: PluginHostCallBindingOptions) {
    this.panelMessaging = createPluginPanelMessaging({
      resolveApprovedPlugin: options.resolveApprovedPlugin,
      grantedCapabilities: options.grantedCapabilities,
      hasOpenFrame: options.hasOpenFrame,
      sink: () => this.panelMessageSink,
      deliverToWorker: options.deliverToWorker
    })
  }

  setRuntimeDelegate(delegate: PluginRuntimeDelegate | null): void {
    this.runtimeDelegate = delegate
  }

  /** Where `panel.post` messages go: the desktop binds a broadcast to its windows. */
  setPanelMessageSink(sink: PluginPanelMessageSink | null): void {
    this.panelMessageSink = sink
  }

  execute(
    pluginKey: string,
    method: string,
    params: unknown,
    surface: PluginSurface
  ): Promise<PluginHostCallOutcome> {
    return executePluginHostCallRequest({
      pluginKey,
      request: { method, params },
      surface,
      resolvePolicy: (boundPluginKey) => ({
        grantedCapabilities: this.options.grantedCapabilities(boundPluginKey),
        services: this.runtimeDelegate
          ? bindPluginHostServices({
              delegate: this.runtimeDelegate,
              pluginsDataDir: getPluginsDataDir(this.options.userDataPath),
              panels: this.panelMessaging
            })
          : null,
        audit: this.options.audit
      })
    })
  }
}
