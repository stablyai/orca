import '../../../../../shared/protocol-version'
import { AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY } from '../../../../../shared/automations/automation-runtime-capabilities'
import type { AutomationOwnerPrecondition } from '../../../../../shared/automations/ownership/automation-owner-precondition'
import { remoteRpcContentBudget } from '../../../../../shared/remote-rpc-content-budget'
import { defineMethod, type RpcContext } from '../../core'
import { previewAutomationRunsPage } from './automation-runs-preview-page'
import {
  AutomationCreate,
  AutomationId,
  AutomationList,
  AutomationRuns,
  AutomationUpdate
} from '../../../../../shared/rpc-contract/automations/automation-params'

function mutationOwner(
  id: string,
  expectedOwner: AutomationOwnerPrecondition | undefined,
  context: RpcContext
): AutomationOwnerPrecondition | undefined {
  if (
    expectedOwner ||
    context.clientCapabilities === undefined ||
    context.clientCapabilities.includes(AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY)
  ) {
    return expectedOwner
  }
  // Legacy clients cannot echo owner metadata, so snapshot it at the RPC boundary.
  return context.runtime.automationOwnerPrecondition(id) ?? undefined
}

export const AUTOMATION_METHODS = [
  defineMethod({
    name: 'automation.list',
    permission: 'workspace',
    params: AutomationList,
    // The projection retains `automations`, so old clients ignore the added owner metadata.
    handler: (params, { runtime }) => runtime.listAutomationsForScope(params)
  }),
  defineMethod({
    name: 'automation.show',
    permission: 'workspace',
    params: AutomationId,
    // Return optional owner metadata for CLI mutations; older hosts omit it and older clients ignore it.
    handler: (params, { runtime }) => {
      const automation = runtime.showAutomation(params.id, params.expectedOwner)
      const owner = runtime.automationOwnerPrecondition(params.id)
      return owner ? { automation, owner } : { automation }
    }
  }),
  defineMethod({
    name: 'automation.create',
    permission: 'workspace',
    params: AutomationCreate,
    handler: async (params, { runtime, plugin }) => ({
      automation: await runtime.createAutomation(
        // Provenance comes from the in-process caller only; params cannot claim it.
        plugin
          ? { ...params, createdBy: { kind: 'plugin', pluginKey: plugin.key, name: plugin.name } }
          : params,
        undefined,
        // A plugin disabled while the target resolved must not leave an automation it owns.
        plugin?.assertActive
      )
    })
  }),
  defineMethod({
    name: 'automation.update',
    permission: 'workspace',
    params: AutomationUpdate,
    handler: async (params, context) => ({
      automation: await context.runtime.updateAutomation(params.id, params.updates, {
        expectedOwner: mutationOwner(params.id, params.expectedOwner, context),
        destination: params.destination,
        expectedWorkspaceMode: params.expectedWorkspaceMode
      })
    })
  }),
  defineMethod({
    name: 'automation.delete',
    permission: 'workspace',
    params: AutomationId,
    handler: (params, context) =>
      context.runtime.deleteAutomation(
        params.id,
        mutationOwner(params.id, params.expectedOwner, context)
      )
  }),
  defineMethod({
    name: 'automation.runNow',
    permission: 'workspace',
    params: AutomationId,
    handler: async (params, context) => ({
      run: await context.runtime.runAutomationNow(
        params.id,
        mutationOwner(params.id, params.expectedOwner, context)
      )
    })
  }),
  defineMethod({
    name: 'automation.runs',
    permission: 'workspace',
    params: AutomationRuns,
    handler: (params, { runtime, requestId }) => {
      if (params.runId !== undefined) {
        if (!params.automationId) {
          throw new Error('A run id requires an automation id.')
        }
        return {
          run: runtime.showAutomationRun(params.automationId, params.runId, params.expectedOwner)
        }
      }
      if (params.preview) {
        return previewAutomationRunsPage(
          runtime.listAutomationRunsPage(
            params.automationId,
            params.expectedOwner,
            params.limit,
            params.cursor
          ),
          remoteRpcContentBudget(requestId ?? '')
        )
      }
      if (params.limit !== undefined || params.cursor !== undefined) {
        return runtime.listAutomationRunsPage(
          params.automationId,
          params.expectedOwner,
          params.limit,
          params.cursor
        )
      }
      return { runs: runtime.listAutomationRuns(params.automationId, params.expectedOwner) }
    }
  })
]
