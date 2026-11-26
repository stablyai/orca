import '../../../../../shared/remote-runtime/protocol/protocol-version'
import { AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY } from '../../../../../shared/automations/automation-runtime-capabilities'
import type { AutomationOwnerPrecondition } from '../../../../../shared/automations/ownership/automation-owner-precondition'
import { remoteRpcContentBudget } from '../../../../../shared/remote-runtime/rpc/remote-rpc-content-budget'
import { defineMethod, type RpcContext, InvalidArgumentError } from '../../core'
import { previewAutomationRunsPage } from './automation-runs-preview-page'
import {
  AutomationCreate,
  AutomationPermissionPolicy,
  AutomationId,
  AutomationList,
  AutomationRuns,
  AutomationUpdate
} from '../../../../../shared/rpc-contract/automations/automation-params'
import { recordAutomationSavedCard } from '../../../automation-saved-card'
import { deleteAutomationRecordingCancelledWait } from '../../../../bots/bot-wait-cancel'
import { LOOK_AROUND_REFUSAL } from '../../../../bots/bot-look-around-policy'
import { automationForClient, readsGoogleRules } from '../../google-rules-for-client'
import { targetInCallerChat } from './runs-in-caller-chat'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import { onceClaimed } from '../../../../../shared/automation-once'

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

/** A session id names a chat only on its own host, so a paired client's claim names none. */
function chatOfCaller(
  callerSessionId: string | undefined,
  context: Pick<RpcContext, 'pairedDeviceId'>
): string | undefined {
  return context.pairedDeviceId === undefined ? callerSessionId : undefined
}

/** Waits whose one run has started: each is deleted once that run finishes, not waiting meanwhile. */
function firedWaits(
  runtime: Pick<RpcContext['runtime'], 'listAutomationRunsByAutomation'>,
  automations: readonly Automation[]
): string[] {
  const waits = automations.filter((automation) => automation.once).map(({ id }) => id)
  if (waits.length === 0) {
    return []
  }
  try {
    const runs = runtime.listAutomationRunsByAutomation(waits)
    return waits.filter((id) => onceClaimed(runs.get(id) ?? []))
  } catch {
    // Unreadable run history must not fail the list; its waits read as before.
    return []
  }
}

/** A look-around run only reads, so it can't make or change automations. */
function refuseFromLookAround(callerSessionId: string | undefined, context: RpcContext): void {
  const caller = chatOfCaller(callerSessionId, context)
  if (caller && context.runtime.lookAround?.botOfLook(caller)) {
    throw new InvalidArgumentError(LOOK_AROUND_REFUSAL)
  }
}

export const AUTOMATION_METHODS = [
  defineMethod({
    name: 'automation.setPermissionPolicy',
    permission: 'settings-write',
    params: AutomationPermissionPolicy,
    handler: async ({ expected, enabled, expectedBotIds, botIds }, { runtime }) => {
      const store = runtime.requireStore()
      if (!store.runDurableMutation || !store.updateSettings) {
        throw new Error('runtime_unavailable')
      }
      const applySettings = store.updateSettings.bind(store)
      return store.runDurableMutation(() => {
        const previous = store.getSettings().automationFullAccess === true
        const previousBots = store.getSettings().fullAccessBotIds ?? []
        const sameBots = (a: string[], b: string[]) =>
          JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
        if (previous !== expected || !sameBots(previousBots, expectedBotIds)) {
          throw new InvalidArgumentError('Automation permission policy changed; read it again.')
        }
        if (botIds.some((id) => !runtime.bots.list().some((bot) => bot.id === id))) {
          throw new InvalidArgumentError('Full Access policy names an unknown bot.')
        }
        applySettings(
          { automationFullAccess: enabled, fullAccessBotIds: botIds },
          { notifyListeners: true }
        )
        return {
          value: { automationFullAccess: enabled, fullAccessBotIds: botIds },
          rollback: () => {
            if (
              store.getSettings().automationFullAccess === enabled &&
              sameBots(store.getSettings().fullAccessBotIds ?? [], botIds)
            ) {
              applySettings(
                { automationFullAccess: previous, fullAccessBotIds: previousBots },
                { notifyListeners: true }
              )
            }
          }
        }
      })
    }
  }),
  defineMethod({
    name: 'automation.list',
    permission: 'workspace',
    params: AutomationList,
    // The projection retains `automations`, so old clients ignore the added owner metadata.
    handler: (params, context) => {
      const listed = context.runtime.listAutomationsForScope(params)
      const fired = firedWaits(context.runtime, listed.automations)
      return {
        ...listed,
        ...(readsGoogleRules(context)
          ? {}
          : {
              automations: listed.automations.map((entry) => automationForClient(entry, context))
            }),
        ...(fired.length > 0 ? { firedWaits: fired } : {})
      }
    }
  }),
  defineMethod({
    name: 'automation.show',
    permission: 'workspace',
    params: AutomationId,
    // Return optional owner metadata for CLI mutations; older hosts omit it and older clients ignore it.
    handler: (params, context) => {
      const { runtime } = context
      const automation = automationForClient(
        runtime.showAutomation(params.id, params.expectedOwner),
        context
      )
      const owner = runtime.automationOwnerPrecondition(params.id)
      return owner ? { automation, owner } : { automation }
    }
  }),
  defineMethod({
    name: 'automation.create',
    permission: 'workspace',
    params: AutomationCreate,
    handler: async ({ callerSessionId, runsInDefault, waitInCallerChat, ...params }, context) => {
      refuseFromLookAround(callerSessionId, context)
      const caller = chatOfCaller(callerSessionId, context)
      const bot =
        params.bot && (runsInDefault || (waitInCallerChat && params.once))
          ? await targetInCallerChat(context.runtime, caller, params.bot, Boolean(params.once))
          : params.bot
      const { plugin } = context
      const input = { ...params, bot }
      const automation = plugin
        ? await context.runtime.createAutomation(
            // Provenance comes from the in-process caller only; params cannot claim it.
            { ...input, createdBy: { kind: 'plugin', pluginKey: plugin.key, name: plugin.name } },
            undefined,
            // A plugin disabled while the target resolved must not leave an automation it owns.
            plugin.assertActive
          )
        : await context.runtime.createAutomation(input)
      recordAutomationSavedCard(caller, 'created', automation)
      return { automation: automationForClient(automation, context) }
    }
  }),
  defineMethod({
    name: 'automation.update',
    permission: 'workspace',
    params: AutomationUpdate,
    handler: async (params, context) => {
      refuseFromLookAround(params.callerSessionId, context)
      const automation = await context.runtime.updateAutomation(params.id, params.updates, {
        expectedOwner: mutationOwner(params.id, params.expectedOwner, context),
        destination: params.destination,
        expectedWorkspaceMode: params.expectedWorkspaceMode
      })
      const caller = chatOfCaller(params.callerSessionId, context)
      recordAutomationSavedCard(caller, 'updated', automation)
      return { automation: automationForClient(automation, context) }
    }
  }),
  defineMethod({
    name: 'automation.delete',
    permission: 'workspace',
    params: AutomationId,
    handler: (params, context) =>
      deleteAutomationRecordingCancelledWait(
        context.runtime,
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
