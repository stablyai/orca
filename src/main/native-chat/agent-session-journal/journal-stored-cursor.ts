import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalHostDatabase } from './journal-host-database'
import { JournalOutcomeDecodeError } from './journal-outcome-codec'
import { journalOutcomeSource } from './journal-outcome-format'
import { readJournalSessionEpoch } from './journal-row-table'
import {
  agentSessionExecutionLocationsEqual,
  type AgentSessionExecutionLocation
} from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredAttentionRead } from '../../../shared/agent-session/agent-session-attention'

export function readStoredWorkspaceAttention(
  database: JournalHostDatabase,
  conversations: readonly { sessionId: string; location: AgentSessionExecutionLocation }[],
  location: AgentSessionExecutionLocation
): (StructuredAttentionRead & { scope: AgentSessionExecutionLocation })[] {
  return conversations.flatMap((record) => {
    if (!agentSessionExecutionLocationsEqual(record.location, location)) {
      return []
    }
    try {
      const observedCursor = readStoredJournalCursor(database, record.sessionId)
      return observedCursor
        ? [{ sessionId: record.sessionId, scope: { ...record.location }, observedCursor }]
        : []
    } catch (error) {
      console.warn('[notifications] Could not capture workspace attention boundary', {
        sessionId: record.sessionId,
        error
      })
      return []
    }
  })
}

/** Read coverage without opening or reducing a resting conversation. */
function readStoredJournalCursor(
  database: JournalHostDatabase,
  sessionId: string
): AgentJournalCursor | null {
  const db = database.db
  const epoch = readJournalSessionEpoch(db, sessionId)
  if (epoch === null) {
    return null
  }
  const source = journalOutcomeSource(db, sessionId, epoch)
  const sequence = source
    ? source.through
    : (db
        .prepare('SELECT MAX(seq) AS seq FROM journal_rows WHERE session_id = ? AND epoch = ?')
        .get(sessionId, epoch)?.seq ?? 0)
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new JournalOutcomeDecodeError('invalid journal cursor')
  }
  return { epoch, sequence }
}
