import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type {
  AutomationChatLaunchRequest,
  AutomationChatAgentLaunch
} from './automation-chat-agent-launch'
import { automationRunRecency } from '../../shared/automation-session-reuse'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { AUTOMATION_AGENT_CALLER, automationRunOperationId } from './automation-run-operation'
import { rpcCallerOperationKey } from '../runtime/rpc/rpc-caller-identity'
import {
  structuredAgentSessionMessageSendMutation,
  structuredAgentSessionSendBody
} from '../../shared/structured-agent-session-send-mutation'
import { automationRunAcceptedTarget } from './automation-agent-run-result'

export async function reuseAutomationChat(
  runtime: OrcaRuntimeService,
  { automation, run, runs }: AutomationChatLaunchRequest
): Promise<AutomationChatAgentLaunch | null> {
  let preparationError: { error: unknown } | undefined
  const store = await runtime.openAgentSessionRecordStore().catch((error: unknown) => {
    preparationError = { error }
    return null
  })
  try {
    await runtime.ensureStructuredAgentSessionHost()
  } catch (error) {
    preparationError = { error }
  }
  const host = getStructuredAgentSessionHost()
  const seen = new Set<string>()
  for (const previous of runs
    .filter((entry) => entry.automationId === automation.id && entry.id !== run.id)
    .toSorted((a, b) => automationRunRecency(b) - automationRunRecency(a))) {
    const id = previous.chatSessionId
    if (previous.sessionKind !== 'chat' || !id || seen.has(id)) {
      continue
    }
    seen.add(id)
    const target: AutomationChatAgentLaunch = {
      // The caller only attempts Chat reuse for a stable workspace.
      workspaceId: automation.workspaceId!,
      workspaceDisplayName: null,
      sessionKind: 'chat',
      chatSessionId: id,
      terminalHandle: null,
      terminalSessionId: null,
      terminalPaneKey: null,
      terminalPtyId: null
    }
    try {
      if (!store) {
        throw preparationError?.error
      }
      const selected = store.selectWritableRecord(id)
      if (selected.kind === 'missing' && !store.readOnly) {
        continue
      }
      if (selected.kind !== 'writable' || store.isSessionUnreadable(id)) {
        throw new Error('Chat record is unavailable')
      }
      const current = store.getConversation(id)
      if (!current) {
        throw new Error('Chat record is unavailable')
      }
      if (
        current.provider !== automation.agentId ||
        current.location.workspaceId !== automation.workspaceId
      ) {
        continue
      }
      target.workspaceId = current.location.workspaceId
      if (preparationError || !host) {
        throw preparationError?.error ?? new Error('Chat host is unavailable')
      }
      const operationId = automationRunOperationId(run, 'reuse-send')
      const callerKey = rpcCallerOperationKey(AUTOMATION_AGENT_CALLER)
      const sent = await host.send(
        { callerKey },
        structuredAgentSessionMessageSendMutation({
          sessionId: id,
          clientOperationId: operationId,
          expectedRuntimeFence: current.currentFence,
          delivery: 'queue-if-active',
          body: structuredAgentSessionSendBody(automation.prompt, [])
        })
      )
      if (sent.ok) {
        return target
      }
      if (
        sent.refusal.code === 'agent_session_ownership_unknown' &&
        sent.refusal.details?.reason === 'sessionNotAttached' &&
        !store.readOnly &&
        store.selectWritableRecord(id).kind === 'missing' &&
        !store.isSessionUnreadable(id) &&
        !store.getOperationRow(callerKey, operationId) &&
        store.readCommandReceipt({ kind: 'global' }, operationId).verdict === 'absent'
      ) {
        return null
      }
      return automationRunAcceptedTarget(
        runtime,
        run,
        target,
        new Error('send refused'),
        automation.agentId
      )
    } catch (error) {
      return automationRunAcceptedTarget(runtime, run, target, error, automation.agentId)
    }
  }
  return null
}
