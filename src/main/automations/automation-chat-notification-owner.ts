import type { AgentSessionTurnCompletion } from '../../shared/agent-session-wire'
import type { AutomationRun } from '../../shared/automations-types'
import type { AgentJournalSnapshot } from '../../shared/agent-session-journal-types'
import type { AutomationRunReceipt } from './automation-run-receipt'
import { resolveChatAutomationRun } from './automation-chat-run-observation'
import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'

export async function ownsAutomationChatCompletion(
  completion: AgentSessionTurnCompletion,
  deps: {
    settleDispatches: () => Promise<void>
    runs: () => readonly AutomationRun[]
    receipt: (run: AutomationRun) => AutomationRunReceipt | null
    snapshot: (sessionId: string) => Promise<AgentJournalSnapshot>
  }
): Promise<boolean> {
  // A fast first turn may finish before its accepted launch receipt is published.
  await deps.settleDispatches()
  const receipts = deps.runs().flatMap((run) => {
    const receipt = deps.receipt(run)
    return receipt?.kind === 'chat' &&
      receipt.accepted &&
      receipt.messageId &&
      receipt.sessionId === completion.sessionId &&
      receipt.workspaceId === completion.scope.workspaceId
      ? [receipt]
      : []
  })
  if (!receipts.length) {
    return false
  }
  const snapshot = await deps.snapshot(completion.sessionId)
  return receipts.some((receipt) => {
    if (!receipt.messageId) {
      return false
    }
    const resolved = resolveChatAutomationRun(snapshot, receipt.messageId, '')
    return (
      resolved.turnItem?.itemId === completion.turnId ||
      (!resolved.turnItem &&
        resolved.submission?.dispatchState === 'rejected' &&
        agentJournalSubmissionKey(receipt.messageId) === completion.turnId)
    )
  })
}
