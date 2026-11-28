// Where a self-sent run's prompt went when Orca quit before saving its chat.
import type { AutomationRun } from '../../../shared/automations/history/automation-run'
import { runtimeBotGroups } from '../../bots/bot-group-runtime'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { automationRunOperationId } from '../launch/automation-run-operation'

export type SelfSentRunPlacement =
  | { kind: 'chat'; sessionId: string; workspaceId: string }
  /** Nothing holds the prompt, so the agent never got it. */
  | { kind: 'unsent' }
  /** Something took it that can't be confirmed: an unreadable or deleted chat, a send from a build
   *  before run-derived ids, or a group room post (owed or not). Sending it again could reach the
   *  agent twice. */
  | { kind: 'unconfirmed' }

export async function selfSentRunPlacement(
  runtime: OrcaRuntimeService,
  run: Pick<AutomationRun, 'id' | 'createdAt'>
): Promise<SelfSentRunPlacement> {
  const messageId = automationRunOperationId(run, 'run-message')
  const records = await runtime.openAgentSessionRecordStore()
  const chats = await records.chatsHoldingRun(messageId, run.id)
  const held = chats.byMessage[0]
  if (held) {
    const workspaceId = records.getConversation(held)?.location.workspaceId
    return workspaceId ? { kind: 'chat', sessionId: held, workspaceId } : { kind: 'unconfirmed' }
  }
  // A room post took the prompt: its room's delivery sends it, so the run is never sent again.
  const posted = runtimeBotGroups(runtime).store.operationMessage(messageId) !== null
  return chats.byRun.length === 0 && !posted ? { kind: 'unsent' } : { kind: 'unconfirmed' }
}
