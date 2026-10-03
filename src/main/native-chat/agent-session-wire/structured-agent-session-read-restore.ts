import { existsSync } from 'node:fs'
import { findJournalFileFormatRemnant } from '../agent-session-journal/journal-file-format-remnant'
import { legacyJournalDatabaseFile } from '../agent-session-journal/journal-paths'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { JournalHostDatabase } from '../agent-session-journal/journal-host-database'
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
  if (
    readJournalSessionEpoch(database.db, sessionId) === null &&
    !hasHistoryOutsideJournalDatabase(database, record)
  ) {
    return null
  }
  return openStructuredAgentSessionConversationJournal(deps, record, {
    deferPerSessionImport: true
  })
}

/** Not in the host's database yet, its history may still sit in a per-chat file the open imports,
 *  or in the pre-SQLite format the open explains. */
export function hasHistoryOutsideJournalDatabase(
  database: Pick<JournalHostDatabase, 'legacyDirectoryFor'>,
  record: Pick<AgentSessionRecord, 'sessionId' | 'location'>
): boolean {
  const legacyDirectory = database.legacyDirectoryFor({
    workspaceId: record.location.workspaceId,
    sessionId: record.sessionId
  })
  return (
    existsSync(legacyJournalDatabaseFile(legacyDirectory)) ||
    findJournalFileFormatRemnant(legacyDirectory) !== null
  )
}
