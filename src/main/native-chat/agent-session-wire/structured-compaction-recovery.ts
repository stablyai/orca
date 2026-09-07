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
  if (
    command?.command !== 'compact' ||
    command.phase !== 'prepared' ||
    command.runtimeFence === undefined ||
    command.runtimeFence === fence
  ) {
    return
  }
  const error = 'Previous compaction completion could not be confirmed after session recovery.'
  await journal.appendItem(
    { provider: 'orca', clientMessageId: `compact:${command.operationId}` },
    { kind: 'status', text: error },
    { fence }
  )
  const recovered = { ...command, phase: 'committed' as const, state: 'unknown' as const, error }
  await store.setConversationCommand(sessionId, fence, recovered)
  await store.recordOperationOutcome({
    callerKey: command.callerKey,
    operationId: command.operationId,
    outcome: { status: 'succeeded', sessionId, conversationCommand: recovered }
  })
}
