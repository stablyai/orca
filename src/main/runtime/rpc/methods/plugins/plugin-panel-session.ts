import { defineStreamingMethod } from '../../core'
import { PluginPanelSessionParams } from '../../../../../shared/rpc-contract/plugins-params'
import { bindRpcPanelOwner, requirePluginService } from './plugins'

let panelSessionSeq = 0

export const PLUGIN_PANEL_SESSION_METHODS = [
  defineStreamingMethod({
    // A paired desktop draws its own copy of the panel; this host runs it. The stream's socket
    // owns the session, so the client sends that panel's `plugins.panelAction` calls on it too.
    name: 'plugins.panelSession',
    permission: 'host-admin',
    params: PluginPanelSessionParams,
    handler: async (params, context, emit) => {
      const service = requirePluginService()
      await service.whenReady()
      if (
        service.findValidPlugin(params.pluginKey)?.consentFingerprint !== params.consentFingerprint
      ) {
        throw new Error(
          `this host does not have the same ${params.pluginKey} installed and approved`
        )
      }
      const ownerKey = bindRpcPanelOwner(service, context)
      const entry = await service.panels.open(ownerKey, params.pluginKey, params.panelId)
      const session = entry ? service.panels.sessionCaller(ownerKey, entry.sessionToken) : null
      if (!entry || !session || context.signal?.aborted) {
        service.panels.revokeOwner(ownerKey)
        throw new Error(`${params.pluginKey} has no panel ${params.panelId} on this host`)
      }
      await new Promise<void>((resolve) => {
        const stop = service.panelBridge.open(session.caller, session.pluginKey, (push) =>
          emit({ type: 'push', push })
        )
        context.runtime.registerSubscriptionCleanup(
          `plugins-panel-session-${context.connectionId ?? 'inproc'}-${++panelSessionSeq}`,
          () => {
            stop()
            service.panels.revokeSession(ownerKey, entry.sessionToken)
            emit({ type: 'end' })
            resolve()
          },
          context.connectionId,
          context.requestId
        )
        emit({ type: 'ready', sessionToken: entry.sessionToken })
      })
    }
  })
]
