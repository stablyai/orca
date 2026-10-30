import { defineMethod, type RpcContext } from '../core'
import type { PluginFrameEntry } from '../../../../shared/plugins/frames/plugin-frame-bridge'
import { listPluginsForClients } from '../../../plugins/plugin-client-list'
import type { PluginHostListEntry } from '../../../../shared/plugins/plugin-list-entry'
import type { PluginService } from '../../../plugins/plugin-service'
import {
  pluginConsentRequestSchema,
  type PluginConsentRequest
} from '../../../../shared/plugins/approval/plugin-consent-request'
import {
  PluginInvokeCommandParams,
  PluginReadPanelEntryParams,
  PluginSetEnabledParams,
  PluginsPanelActionParams
} from '../../../../shared/rpc-contract/plugins-params'

/** Expose desktop IPC's plugin consent/actions over serve/headless RPC through the same PluginService permission boundary. */

// Inject the separate composition-root PluginService without widening shared RpcContext.
let pluginServiceForRpc: PluginService | null = null
// Consent/enablement need the settings Store too, so the entry injects bound
// closures instead of the store itself.
let pluginConsentForRpc: ((request: PluginConsentRequest) => Promise<void>) | null = null
let pluginEnablementForRpc: ((pluginKey: string, enabled: boolean) => Promise<void>) | null = null

export function setPluginServiceForRpc(
  service: PluginService | null,
  writes?: {
    applyConsent: (request: PluginConsentRequest) => Promise<void>
    applyEnablement: (pluginKey: string, enabled: boolean) => Promise<void>
  }
): void {
  pluginServiceForRpc = service
  pluginConsentForRpc = writes?.applyConsent ?? null
  pluginEnablementForRpc = writes?.applyEnablement ?? null
}

function requirePluginService(): PluginService {
  if (!pluginServiceForRpc) {
    throw new Error('Plugin service is not available on this runtime')
  }
  return pluginServiceForRpc
}

async function listForRpc(): Promise<PluginHostListEntry[]> {
  return listPluginsForClients(requirePluginService())
}

function rpcPanelOwner(context: RpcContext): string {
  // Bind bearer sessions to individual paired connections, even for sibling sockets of one device.
  return `runtime:${context.connectionId ?? context.clientId ?? 'local'}`
}

function bindRpcPanelOwner(service: PluginService, context: RpcContext): string {
  const ownerKey = rpcPanelOwner(context)
  service.panels.bindOwnerSignal(ownerKey, context.signal)
  return ownerKey
}

export const PLUGIN_METHODS = [
  defineMethod({
    name: 'plugins.list',
    permission: 'workspace',
    params: null,
    handler: async () => listForRpc()
  }),
  defineMethod({
    // Headless servers have no dialog; only explicit consent can activate a pending plugin.
    name: 'plugins.consent',
    permission: 'host-admin',
    params: pluginConsentRequestSchema,
    handler: async (params) => {
      const service = requirePluginService()
      await service.whenReady()
      if (!pluginConsentForRpc) {
        throw new Error('Plugin consent is not available on this runtime')
      }
      await pluginConsentForRpc(params)
      return listForRpc()
    }
  }),
  defineMethod({
    name: 'plugins.setEnabled',
    permission: 'host-admin',
    params: PluginSetEnabledParams,
    handler: async (params) => {
      const service = requirePluginService()
      await service.whenReady()
      if (!pluginEnablementForRpc) {
        throw new Error('Plugin enablement is not available on this runtime')
      }
      await pluginEnablementForRpc(params.pluginKey, params.enabled)
      return listForRpc()
    }
  }),
  defineMethod({
    // Enforce panel capabilities here too because headless clients relay bridge calls over RPC.
    name: 'plugins.panelAction',
    permission: 'host-admin',
    // Apply raw admission before strict parsing so malformed/oversize traffic still consumes panel budget.
    params: PluginsPanelActionParams,
    handler: async (params, context) => {
      const service = requirePluginService()
      await service.whenReady()
      return {
        outcome: await service.panels.execute(bindRpcPanelOwner(service, context), params)
      }
    }
  }),
  defineMethod({
    name: 'plugins.readPanelEntry',
    permission: 'workspace',
    params: PluginReadPanelEntryParams,
    handler: async (params, context): Promise<PluginFrameEntry | null> => {
      const service = requirePluginService()
      await service.whenReady()
      const ownerKey = bindRpcPanelOwner(service, context)
      const entry = await service.panels.open(ownerKey, params.pluginKey, params.panelId)
      if (context.signal?.aborted) {
        service.panels.revokeOwner(ownerKey)
        return null
      }
      return entry
    }
  }),
  defineMethod({
    name: 'plugins.invokeCommand',
    permission: 'host-admin',
    params: PluginInvokeCommandParams,
    handler: async (params) => {
      const service = requirePluginService()
      await service.whenReady()
      return service.invokeCommand(params.pluginKey, params.commandId, params.args)
    }
  })
]
