import type { AutomationRun } from '../../shared/automations-types'
import { isAgentLaunchResult, type AgentLaunchResult } from '../../shared/agent-launch-intent'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import { rpcCallerOperationKey } from '../runtime/rpc/rpc-caller-identity'
import { AUTOMATION_AGENT_CALLER, automationRunOperationId } from './automation-run-operation'

export type AutomationRunReceipt =
  | {
      kind: 'chat'
      sessionId: string
      workspaceId: string
      messageId: string | null
      accepted: boolean
    }
  | {
      kind: 'terminal'
      accepted: boolean
      launch: AgentLaunchResult & {
        outcome: Extract<AgentLaunchResult['outcome'], { kind: 'terminal' }>
      }
    }

/** Publication and acceptance are separate receipts; neither recovery path sends again. */
export function readAutomationRunReceipt(
  store: Pick<AgentSessionRecordStore, 'getOperationRow' | 'getConversation'>,
  run: Pick<AutomationRun, 'id' | 'createdAt'>
): AutomationRunReceipt | null {
  const callerKey = rpcCallerOperationKey(AUTOMATION_AGENT_CALLER)
  for (const purpose of ['fresh-launch'] as const) {
    const row = store.getOperationRow(callerKey, automationRunOperationId(run, purpose))
    if (!row) {
      continue
    }
    if (row.outcome.status !== 'succeeded' || !isAgentLaunchResult(row.outcome.launch)) {
      return null
    }
    const launch = row.outcome.launch
    if (launch.receipt.preferred !== 'structured') {
      return null
    }
    if (launch.outcome.kind === 'structured') {
      return {
        kind: 'chat',
        sessionId: launch.outcome.sessionId,
        workspaceId: launch.worktreeId,
        messageId: launch.prompt?.outcome === 'journaled' ? launch.prompt.messageId : null,
        accepted: launch.prompt?.outcome === 'journaled'
      }
    }
    if (launch.outcome.kind === 'terminal') {
      return {
        kind: 'terminal',
        accepted: launch.prompt?.outcome === 'handed-to-terminal',
        launch: { ...launch, outcome: launch.outcome }
      }
    }
    return null
  }
  const messageId = automationRunOperationId(run, 'reuse-send')
  const send = store.getOperationRow(callerKey, messageId)
  if (send?.outcome.status !== 'succeeded') {
    return null
  }
  const conversation = store.getConversation(send.outcome.sessionId)
  return conversation
    ? {
        kind: 'chat',
        sessionId: send.outcome.sessionId,
        workspaceId: conversation.location.workspaceId,
        messageId,
        accepted: true
      }
    : null
}
