import { defineStreamingMethod } from '../../core'
import { PluginPanelSessionParams } from '../../../../../shared/rpc-contract/plugins/plugins-params'
import { bindRpcPanelOwner, requirePluginService } from './plugins'

let panelSessionSeq = 0
// One socket's streams for the same panel share its token, so only the last one revokes it.
const streamsByToken = new Map<string, number>()

function holdToken(ownerKey: string, sessionToken: string): () => boolean {
  const key = `${ownerKey}\0${sessionToken}`
  streamsByToken.set(key, (streamsByToken.get(key) ?? 0) + 1)
  let released = false
  return () => {
    if (released) {
      return false
    }
    released = true
    const left = (streamsByToken.get(key) ?? 1) - 1
    if (left > 0) {
      streamsByToken.set(key, left)
      return false
    }
    streamsByToken.delete(key)
    return true
  }
}

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
        throw new Error(`this host does not have the same ${params.pluginKey} installed`)
      }
      // Why: the same plugin still waiting for approval, or disabled, on the host would otherwise
      // read as a missing panel and send the person away from the approval it needs there.
      if (!service.findApprovedPlugin(params.pluginKey)) {
        throw new Error(
          `${params.pluginKey} is installed on this host but is not approved and enabled there`
        )
      }
      const ownerKey = bindRpcPanelOwner(service, context)
      const entry = await service.panels.open(ownerKey, params.pluginKey, params.panelId)
      if (!entry) {
        throw new Error(`${params.pluginKey} has no panel ${params.panelId} on this host`)
      }
      const releaseToken = holdToken(ownerKey, entry.sessionToken)
      const revokeIfLast = (): void => {
        if (releaseToken()) {
          service.panels.revokeSession(ownerKey, entry.sessionToken)
        }
      }
      const session = service.panels.sessionCaller(ownerKey, entry.sessionToken)
      if (!session || context.signal?.aborted) {
        revokeIfLast()
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
            revokeIfLast()
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
