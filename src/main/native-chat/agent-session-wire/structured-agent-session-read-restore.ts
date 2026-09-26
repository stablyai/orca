import { findJournalFileFormatRemnant } from '../agent-session-journal/journal-file-format-remnant'
import { existsSync } from 'node:fs'
import { journalDatabaseFile, journalDirectoryFor } from '../agent-session-journal/journal-paths'
import {
  openStructuredAgentSessionConversationJournal,
  type OpenedStructuredAgentSessionConversation,
  type StructuredAgentSessionConversationOpenDeps
} from './structured-agent-session-conversation-open'

/**
 * A reader's open: the conversation's own open, for a session that has a journal to read. One
 * with none — never written, or gone — stays unpublished rather than founding an empty one.
 * Opening can still write: the crash boundary, and the row explaining an old-format history.
 */
export async function restoreStructuredAgentSessionRead(
  deps: StructuredAgentSessionConversationOpenDeps,
  sessionId: string
): Promise<OpenedStructuredAgentSessionConversation | null> {
  const record = deps.store.getRecord(sessionId)
  if (!record) {
    return null
  }
  const journalDir = journalDirectoryFor(deps.journalRoot, {
    workspaceId: record.location.workspaceId,
    sessionId
  })
  // A session still in the pre-SQLite format has no `journal.db`; the open imports it.
  if (!existsSync(journalDatabaseFile(journalDir)) && !findJournalFileFormatRemnant(journalDir)) {
    return null
  }
  return openStructuredAgentSessionConversationJournal(deps, record)
}
