import { readJournalSessionEpoch } from '../agent-session-journal/journal-row-table'
import {
  openStructuredAgentSessionConversationJournal,
  type OpenedStructuredAgentSessionConversation,
  type StructuredAgentSessionConversationOpenDeps
} from './structured-agent-session-conversation-open'

/**
 * A reader's open: the conversation's own open, for a session that has a journal to read. One
 * with none — never written, or gone — stays unpublished rather than founding an empty one.
 * Opening can still write: the crash boundary.
 */
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
