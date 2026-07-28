import type { MethodHandler, RequestContext } from './dispatcher'
import {
  admitPluginPanelCall,
  createPluginPanelCallAdmission,
  type PluginPanelCallAdmission
} from '../shared/plugins/plugin-panel-call-admission'
import {
  executePluginHostCallRequest,
  isPluginHostCallRequest,
  type ResolvePluginHostCallPolicy
} from '../main/plugins/plugin-host-call-adapter'

export const RELAY_PLUGIN_PANEL_HOST_CALL_METHOD = 'plugins.hostCall.panel'
export const RELAY_PLUGIN_WORKER_HOST_CALL_METHOD = 'plugins.hostCall.worker'

export type RelayPluginHostCallDispatcher = {
  onRequest(method: string, handler: MethodHandler): void
}

export type ResolveRelayPluginHostCallIdentity = (
  context: RequestContext
) => string | null | Promise<string | null>

/** Relay provisioning is deliberately out of scope here. Its connection-
 *  keyed resolver owns plugin identity, consent, services, and audit authority. */
export function registerRelayPluginHostCallHandlers(
  dispatcher: RelayPluginHostCallDispatcher,
  resolveIdentity: ResolveRelayPluginHostCallIdentity,
  resolvePolicy: ResolvePluginHostCallPolicy,
  options: { panelAdmission?: PluginPanelCallAdmission } = {}
): void {
  const panelAdmission = options.panelAdmission ?? createPluginPanelCallAdmission()
  const register = (registeredMethod: string, viaPanel: boolean): void => {
    dispatcher.onRequest(registeredMethod, async (params, context) => {
      let pluginKey: string | null
      try {
        pluginKey = await resolveIdentity(context)
      } catch {
        pluginKey = null
      }
      if (!pluginKey) {
        return {
          ok: false,
          code: 'unavailable',
          error: 'plugin host authority is not available'
        }
      }
      if (viaPanel) {
        const admissionRefusal = admitPluginPanelCall(panelAdmission, pluginKey, params)
        if (admissionRefusal) {
          return admissionRefusal
        }
      }
      if (!isPluginHostCallRequest(params)) {
        return { ok: false, code: 'invalid_request', error: 'malformed plugin host call request' }
      }
      return executePluginHostCallRequest({
        pluginKey,
        request: params,
        viaPanel,
        resolvePolicy
      })
    })
  }
  // Why: transport authority is fixed by the registered RPC method; callers
  // cannot promote a panel call to the wider worker method set in params.
  register(RELAY_PLUGIN_PANEL_HOST_CALL_METHOD, true)
  register(RELAY_PLUGIN_WORKER_HOST_CALL_METHOD, false)
}
