import type { PluginEventName } from '../../shared/plugins/plugin-manifest'
import type { PluginPanelActionOutcome } from '../../shared/plugins/plugin-panel-bridge'
import { getPluginsDataDir } from './plugin-discovery'
import type { DiscoveredPlugin, ValidDiscoveredPlugin } from './plugin-discovery'
import { deliverPluginEvent } from './plugin-event-delivery'
import type { PluginEventBus } from './plugin-event-bus'
import { executePluginHostCallRequest } from './plugin-host-call-adapter'
import { bindPluginHostServices, type PluginRuntimeDelegate } from './plugin-host-service-bindings'
import type { PluginAuditLog } from './plugin-audit-log'
import type { PluginLogBuffer } from './plugin-log-buffer'
import type { PluginWorkerController } from './plugin-worker-controller'
import type { PluginCapabilityKind } from '../../shared/plugins/plugin-capabilities'
import type { PluginUiFocusSnapshot } from './plugin-ui-focus'
import type { PluginSidecarMailbox } from './plugin-sidecar-mailbox'

export type PluginServiceHostCallContext = {
  userDataPath: string
  isPluginSystemEnabled: () => boolean
  disposed: boolean
  discovered: readonly DiscoveredPlugin[]
  eventBus: PluginEventBus
  workerController: PluginWorkerController
  audit: PluginAuditLog
  logBuffer: PluginLogBuffer
  runtimeDelegate: PluginRuntimeDelegate | null
  uiFocus: PluginUiFocusSnapshot
  sidecarMailbox: PluginSidecarMailbox
  getGrantedCapabilities: (pluginKey: string) => PluginCapabilityKind[] | null
  isRuntimeApproved: (plugin: ValidDiscoveredPlugin) => boolean
}

export async function executePluginServiceHostCall(
  ctx: PluginServiceHostCallContext,
  pluginKey: string,
  method: string,
  params: unknown,
  options: { viaPanel: boolean }
): Promise<PluginPanelActionOutcome> {
  return executePluginHostCallRequest({
    pluginKey,
    request: { method, params },
    viaPanel: options.viaPanel,
    resolvePolicy: (boundPluginKey) => ({
      grantedCapabilities: ctx.getGrantedCapabilities(boundPluginKey),
      services: ctx.runtimeDelegate
        ? bindPluginHostServices({
            delegate: ctx.runtimeDelegate,
            pluginsDataDir: getPluginsDataDir(ctx.userDataPath),
            subscribeEvents: (key, events) => ctx.eventBus.subscribe(key, events),
            readFocusedSurface: () => ctx.uiFocus.get(),
            sidecarMailbox: ctx.sidecarMailbox
          })
        : null,
      audit: ctx.audit
    })
  })
}

export function emitPluginServiceEvent(
  ctx: PluginServiceHostCallContext,
  event: PluginEventName,
  payload: unknown
): void {
  if (!ctx.isPluginSystemEnabled() || ctx.disposed) {
    return
  }
  deliverPluginEvent({
    event,
    payload,
    plugins: ctx.discovered,
    eventBus: ctx.eventBus,
    workerController: ctx.workerController,
    isRuntimeApproved: ctx.isRuntimeApproved,
    logWarning: (pluginKey, line) => ctx.logBuffer.append(pluginKey, 'warn', line)
  })
}

export function reportPluginServiceUiFocus(ctx: PluginServiceHostCallContext, raw: unknown): void {
  const { changed, surface } = ctx.uiFocus.apply(raw)
  if (!changed) {
    return
  }
  emitPluginServiceEvent(ctx, 'ui.focus.changed', {
    focusedSurface: surface,
    receivedAt: Date.now()
  })
}
