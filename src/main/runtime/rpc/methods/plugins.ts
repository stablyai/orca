import { z } from 'zod'
import { defineMethod, type RpcContext, type RpcMethod } from '../core'
import type { PluginPanelEntry } from '../../../../shared/plugins/plugin-panel-bridge'
import { listPluginsForClients } from '../../../ipc/plugins'
import type { PluginListEntry } from '../../../plugins/plugin-list-projection'
import type { PluginService } from '../../../plugins/plugin-service'
import {
  pluginConsentRequestSchema,
  type PluginConsentRequest
} from '../../../../shared/plugins/plugin-consent-request'
import { isQualifiedPluginKey } from '../../../../shared/plugins/plugin-manifest'

/**
 * Serve/headless parity surface: the same consent, enablement, panel-action,
 * and command paths the desktop IPC handlers expose, over runtime RPC. Both
 * routes execute through PluginService's single chokepoint, so a permission
 * decision can never differ between a local window and a paired client.
 */

// Why: RpcContext only carries the OrcaRuntimeService, and plugins are a
// separate composition-root service — inject via module setter the way the
// desktop entry wires it, instead of widening the shared RPC context type.
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

const PluginSetEnabledParams = z.object({
  pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key'),
  enabled: z.boolean()
})

const PluginReadPanelEntryParams = z.object({
  pluginKey: z.string().min(1),
  panelId: z.string().min(1)
})

const PluginInvokeCommandParams = z.object({
  pluginKey: z.string().min(1),
  commandId: z.string().min(1),
  args: z.unknown().optional()
})

async function listForRpc(): Promise<PluginListEntry[]> {
  return listPluginsForClients(requirePluginService())
}

function rpcPanelOwner(context: RpcContext): string {
  // Why: the bearer session must not cross paired-client connections even
  // when two sockets authenticate as the same device.
  return `runtime:${context.connectionId ?? context.clientId ?? 'local'}`
}

function bindRpcPanelOwner(service: PluginService, context: RpcContext): string {
  const ownerKey = rpcPanelOwner(context)
  service.panels.bindOwnerSignal(ownerKey, context.signal)
  return ownerKey
}

export const PLUGIN_METHODS: readonly RpcMethod[] = [
  defineMethod({
    name: 'plugins.list',
    params: null,
    handler: async () => listForRpc()
  }),
  defineMethod({
    // Why: headless serve has no consent dialog — an explicit consent call is
    // the only way a pending plugin becomes active on a server.
    name: 'plugins.consent',
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
    // Why: headless serve clients relay panel bridge requests over RPC, so
    // capability enforcement must live behind this method too, not only in
    // the desktop IPC handler.
    name: 'plugins.panelAction',
    // Why: raw admission must run before strict schema parsing so malformed
    // and oversized traffic cannot bypass the panel budget.
    params: z.unknown(),
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
    params: PluginReadPanelEntryParams,
    handler: async (params, context): Promise<PluginPanelEntry | null> => {
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
    params: PluginInvokeCommandParams,
    handler: async (params) => {
      const service = requirePluginService()
      await service.whenReady()
      return service.invokeCommand(params.pluginKey, params.commandId, params.args)
    }
  })
]
