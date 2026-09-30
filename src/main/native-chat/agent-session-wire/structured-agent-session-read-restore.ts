import { existsSync } from 'node:fs'
import { findJournalFileFormatRemnant } from '../agent-session-journal/journal-file-format-remnant'
import { legacyJournalDatabaseFile } from '../agent-session-journal/journal-paths'
import { readJournalSessionEpoch } from '../agent-session-journal/journal-row-table'
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
  const database = deps.journalDatabase
  if (readJournalSessionEpoch(database.db, sessionId) === null) {
    // Not in the host's database yet: its history may still sit in a per-chat file the open
    // imports, or in the pre-SQLite format the open explains.
    const legacyDirectory = database.legacyDirectoryFor({
      workspaceId: record.location.workspaceId,
      sessionId
    })
    if (
      !existsSync(legacyJournalDatabaseFile(legacyDirectory)) &&
      !findJournalFileFormatRemnant(legacyDirectory)
    ) {
      return null
    }
  }
  return openStructuredAgentSessionConversationJournal(deps, record, {
    deferPerSessionImport: true
  })
}
