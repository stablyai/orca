import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

/** A newly acquired owner cannot still be executing the previous owner's command. */
export async function recoverInterruptedCompaction(
  store: AgentSessionRecordStore,
  sessionId: string,
  journal: AgentSessionJournal,
  fence: number
): Promise<void> {
  const command = store.getRecord(sessionId)?.conversationCommand
  if (command?.runtimeFence === undefined || command.runtimeFence === fence) {
    return
  }
  await settleInterruptedCompaction(store, sessionId, journal, fence)
}

/** A compaction still prepared whose child can no longer finish it: its outcome is unknown. */
export async function settleInterruptedCompaction(
  store: AgentSessionRecordStore,
  sessionId: string,
  journal: AgentSessionJournal,
  fence: number
): Promise<void> {
  const command = store.getRecord(sessionId)?.conversationCommand
  if (command?.command !== 'compact' || command.phase !== 'prepared') {
    return
  }
  const words = agentSessionFailureWords(agentSessionFailureFact('compactionUnconfirmed'), {
    surface: 'row'
  })
  await journal.appendItem(
    { provider: 'orca', clientMessageId: `compact:${command.operationId}` },
    { kind: 'status', ...words },
    { fence }
  )
  const recovered = {
    ...command,
    phase: 'committed' as const,
    state: 'unknown' as const,
    error: words.text,
    failure: words.failure
  }
  await store.setConversationCommand(sessionId, fence, recovered)
  await store.recordOperationOutcome({
    callerKey: command.callerKey,
    operationId: command.operationId,
    outcome: { status: 'succeeded', sessionId, conversationCommand: recovered }
  })
}
