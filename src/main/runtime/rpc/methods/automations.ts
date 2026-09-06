import {
  AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY,
  AUTOMATION_SHELL_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { AutomationOwnerPrecondition } from '../../../../shared/automation-owner-precondition'
import { defineMethod, InvalidArgumentError, type RpcContext, type RpcMethod } from '../core'
import {
  AutomationCreate,
  AutomationId,
  AutomationList,
  AutomationRuns,
  AutomationUpdate
} from './automation-schemas'

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

function supportsShellAutomations(context: RpcContext): boolean {
  return (
    context.clientKind === undefined ||
    context.clientCapabilities?.includes(AUTOMATION_SHELL_RUNTIME_CAPABILITY) === true
  )
}

function assertShellAutomationSupport(context: RpcContext): void {
  if (!supportsShellAutomations(context)) {
    throw new InvalidArgumentError('Blank-terminal automations require a newer Orca client.')
  }
}

export const AUTOMATION_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'automation.list',
    params: AutomationList,
    handler: (params, context) => {
      const result = context.runtime.listAutomationsForScope(params)
      if (supportsShellAutomations(context)) {
        return result
      }
      const automations = result.automations.filter((automation) => automation.agentId !== null)
      const visibleIds = new Set(automations.map((automation) => automation.id))
      return {
        ...result,
        automations,
        items: result.items.filter((item) => visibleIds.has(item.automationId))
      }
    }
  }),
  defineMethod({
    name: 'automation.show',
    params: AutomationId,
    // The CLI echoes the authority's owner metadata on subsequent mutations.
    handler: (params, context) => {
      const automation = context.runtime.showAutomation(params.id, params.expectedOwner)
      if (automation.agentId === null) {
        assertShellAutomationSupport(context)
      }
      const owner = context.runtime.automationOwnerPrecondition(params.id)
      return owner ? { automation, owner } : { automation }
    }
  }),
  defineMethod({
    name: 'automation.create',
    params: AutomationCreate,
    handler: async (params, context) => {
      if (params.agentId === null) {
        assertShellAutomationSupport(context)
      }
      return { automation: await context.runtime.createAutomation(params) }
    }
  }),
  defineMethod({
    name: 'automation.update',
    params: AutomationUpdate,
    handler: async (params, context) => {
      const expectedOwner = mutationOwner(params.id, params.expectedOwner, context)
      if (
        !supportsShellAutomations(context) &&
        (params.updates.agentId === null ||
          context.runtime.showAutomation(params.id, expectedOwner).agentId === null)
      ) {
        assertShellAutomationSupport(context)
      }
      return {
        automation: await context.runtime.updateAutomation(params.id, params.updates, {
          expectedOwner,
          destination: params.destination
        })
      }
    }
  }),
  defineMethod({
    name: 'automation.delete',
    params: AutomationId,
    handler: (params, context) =>
      context.runtime.deleteAutomation(
        params.id,
        mutationOwner(params.id, params.expectedOwner, context)
      )
  }),
  defineMethod({
    name: 'automation.runNow',
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
    params: AutomationRuns,
    handler: (params, { runtime }) => {
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
