import { defineMethod, type RpcContext } from '../core'
import type { PluginFrameEntry } from '../../../../shared/plugins/frames/plugin-frame-bridge'
import { listPluginsForClients } from '../../../plugins/plugin-client-list'
import type { PluginHostListEntry } from '../../../../shared/plugins/plugin-list-entry'
import type { PluginService } from '../../../plugins/plugin-service'
import type { PluginConsentRequest } from '../../../../shared/plugins/approval/plugin-consent-request'
import {
  PluginDevLoadParams,
  PluginDevUnloadParams,
  PluginGetLogsParams,
  PluginInvokeCommandParams,
  PluginReadPanelEntryParams,
  PluginRpcConsentParams,
  PluginSetEnabledParams,
  PluginsPanelActionParams
} from '../../../../shared/rpc-contract/plugins-params'
import {
  approvePluginFromCli,
  pluginCliApprovalRequest
} from '../../../plugins/plugin-cli-approval'
import { PluginApprovalRequiredError } from '../../../../shared/plugins/approval/plugin-cli-approval'
import { loadPluginDevFolder, unloadPluginDevFolder } from '../../../plugins/plugin-dev-folders'

/** Expose desktop IPC's plugin consent/actions over serve/headless RPC through the same PluginService permission boundary. */

// Inject the separate composition-root PluginService without widening shared RpcContext.
let pluginServiceForRpc: PluginService | null = null
// Consent/enablement need the settings Store too, so the entry injects bound
// closures instead of the store itself.
let pluginConsentForRpc: ((request: PluginConsentRequest) => Promise<void>) | null = null
let pluginEnablementForRpc: ((pluginKey: string, enabled: boolean) => Promise<void>) | null = null
let pluginDevPathsForRpc: ((paths: string[]) => void) | null = null

export function setPluginServiceForRpc(
  service: PluginService | null,
  writes?: {
    applyConsent: (request: PluginConsentRequest) => Promise<void>
    applyEnablement: (pluginKey: string, enabled: boolean) => Promise<void>
    setDevPluginPaths?: (paths: string[]) => void
  }
): void {
  pluginServiceForRpc = service
  pluginConsentForRpc = writes?.applyConsent ?? null
  pluginEnablementForRpc = writes?.applyEnablement ?? null
  pluginDevPathsForRpc = writes?.setDevPluginPaths ?? null
}

function requirePluginService(): PluginService {
  if (!pluginServiceForRpc) {
    throw new Error('Plugin service is not available on this runtime')
  }
  return pluginServiceForRpc
}

function requireConsentWrite(): (request: PluginConsentRequest) => Promise<void> {
  if (!pluginConsentForRpc) {
    throw new Error('Plugin consent is not available on this runtime')
  }
  return pluginConsentForRpc
}

function requireDevPathsWrite(): (paths: string[]) => void {
  if (!pluginDevPathsForRpc) {
    throw new Error('Plugin development folders are not available on this runtime')
  }
  return pluginDevPathsForRpc
}

async function listEntryForRpc(pluginKey: string | null): Promise<PluginHostListEntry | null> {
  return pluginKey === null
    ? null
    : ((await listForRpc()).find((entry) => entry.pluginKey === pluginKey) ?? null)
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
    // Why the flag even for paired callers: an agent CLI reaches serve as a paired device too, so
    // no transport proves a person clicked; only the fingerprint from `approval_required` grants.
    name: 'plugins.consent',
    permission: 'host-admin',
    params: PluginRpcConsentParams,
    handler: async (params, context) => {
      const service = requirePluginService()
      await service.whenReady()
      const applyConsent = requireConsentWrite()
      if (params.decision === 'keep-disabled') {
        await applyConsent({
          pluginKey: params.pluginKey,
          reviewedFingerprint: params.reviewedFingerprint ?? '',
          decision: 'keep-disabled'
        })
        return listForRpc()
      }
      const plugin = service.findValidPlugin(params.pluginKey)
      if (
        plugin &&
        params.reviewedFingerprint !== undefined &&
        params.reviewedFingerprint !== plugin.consentFingerprint
      ) {
        throw new PluginApprovalRequiredError(pluginCliApprovalRequest(plugin, 'enable'), true)
      }
      await approvePluginFromCli({
        service,
        applyConsent,
        pluginKey: params.pluginKey,
        approvalFingerprint: params.approvalFingerprint,
        action: 'enable',
        caller: context.caller
      })
      return listForRpc()
    }
  }),
  defineMethod({
    name: 'plugins.setEnabled',
    permission: 'host-admin',
    params: PluginSetEnabledParams,
    handler: async (params, context) => {
      const service = requirePluginService()
      await service.whenReady()
      if (!pluginEnablementForRpc) {
        throw new Error('Plugin enablement is not available on this runtime')
      }
      if (!params.enabled) {
        await pluginEnablementForRpc(params.pluginKey, false)
        return listForRpc()
      }
      // Enabling grants whatever consent is missing, so it goes through the same approve flag.
      await approvePluginFromCli({
        service,
        applyConsent: requireConsentWrite(),
        pluginKey: params.pluginKey,
        approvalFingerprint: params.approvalFingerprint,
        action: 'enable',
        caller: context.caller
      })
      return listForRpc()
    }
  }),
  defineMethod({
    // Agent dev loop: same list Settings → Plugins edits; code stays inert without the approve flag.
    name: 'plugins.devLoad',
    permission: 'host-admin',
    params: PluginDevLoadParams,
    handler: async (params, context) => {
      const service = requirePluginService()
      await service.whenReady()
      const result = await loadPluginDevFolder({
        service,
        writes: {
          setDevPluginPaths: requireDevPathsWrite(),
          applyConsent: requireConsentWrite()
        },
        path: params.path,
        approvalFingerprint: params.approvalFingerprint,
        caller: context.caller
      })
      return { ...result, plugin: await listEntryForRpc(result.pluginKey) }
    }
  }),
  defineMethod({
    name: 'plugins.devUnload',
    permission: 'host-admin',
    params: PluginDevUnloadParams,
    handler: async (params) => {
      const service = requirePluginService()
      await service.whenReady()
      return unloadPluginDevFolder({
        service,
        writes: { setDevPluginPaths: requireDevPathsWrite() },
        target:
          params.pluginKey !== undefined
            ? { pluginKey: params.pluginKey }
            : { path: params.path ?? '' }
      })
    }
  }),
  defineMethod({
    name: 'plugins.refresh',
    permission: 'host-admin',
    params: null,
    handler: async () => {
      const service = requirePluginService()
      await service.whenReady()
      await service.refresh()
      return listForRpc()
    }
  }),
  defineMethod({
    name: 'plugins.getLogs',
    permission: 'host-admin',
    params: PluginGetLogsParams,
    handler: async (params) => {
      const service = requirePluginService()
      await service.whenReady()
      return { pluginKey: params.pluginKey, lines: service.getLogs(params.pluginKey) }
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
