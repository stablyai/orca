import { readJournalSessionEpoch } from '../agent-session-journal/journal-row-table'
import {
  openStructuredAgentSessionConversationJournal,
  type OpenedStructuredAgentSessionConversation,
  type StructuredAgentSessionConversationOpenDeps
} from './structured-agent-session-conversation-open'

/** Open only existing journals without founding empty chats; recovery may still write the crash boundary. */
export async function restoreStructuredAgentSessionRead(
  deps: StructuredAgentSessionConversationOpenDeps,
  sessionId: string
): Promise<OpenedStructuredAgentSessionConversation | null> {
  const record = deps.store.getRecord(sessionId)
  if (!record) {
    return null
  }
  if (readJournalSessionEpoch(deps.journalDatabase.db, sessionId) === null) {
    return null
  }
  return openStructuredAgentSessionConversationJournal(deps, record)
}
