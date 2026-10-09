import type { AgentType } from '../../../../shared/native-chat-types'
import { chatAssigneeSessionId } from '../../orchestration/chat-assignee'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { OrchestrationDb } from '../../orchestration/db'
import { readAgentSessionRecordStore } from '../../orchestration/structured-session-records'
import type { StructuredWorkerIdentity } from '../../structured-worker-identity'

/** What a worker transcript read needs of the session it reads, and what its cursor is bound to. */
export type StructuredJournalSource = Pick<
  StructuredWorkerIdentity,
  'sessionId' | 'processIncarnation' | 'paneKey'
>

/**
 * A chat assignee's own journal and cursor identity; null when the assignee is not a chat.
 */
export function chatAssigneeJournal(
  db: OrchestrationDb,
  dispatchId: string
): { source: StructuredJournalSource; agent: AgentType } | null {
  const handle =
    db.getWorkerDispatch(dispatchId)?.agent_terminal_handle ??
    db.getDispatchContextById(dispatchId)?.assignee_handle
  const chat = chatAssigneeSessionId(handle)
  if (!handle || !chat) {
    return null
  }
  const record = readAgentSessionRecordStore()?.getRecord(chat)
  if (!record) {
    throw new OrchestrationError(
      'transcript_required',
      `The transcript for Dispatch ${dispatchId} could not be read; this host has no record of its chat.`
    )
  }
  // The chat's address stands in for a worker's pane and incarnation: it is its whole identity.
  return {
    source: { sessionId: chat, processIncarnation: handle, paneKey: handle },
    agent: record.provider
  }
}
