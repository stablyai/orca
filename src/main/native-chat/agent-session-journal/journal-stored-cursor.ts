import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalHostDatabase } from './journal-host-database'
import {
  decodeJournalOutcome,
  decodingOutcome,
  JournalOutcomeDecodeError
} from './journal-outcome-codec'
import { outcomeFormat1StoredScalars } from './journal-outcome-format-1'
import type { JournalReadConnection } from './journal-sql-owner'
import { journalContextCursor } from './journal-context-cursor'
import {
  agentSessionExecutionLocationsEqual,
  type AgentSessionExecutionLocation
} from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredAttentionRead } from '../../../shared/agent-session/agent-session-attention'

export async function readStoredWorkspaceAttention(
  database: JournalHostDatabase,
  conversations: readonly { sessionId: string; location: AgentSessionExecutionLocation }[],
  location: AgentSessionExecutionLocation
): Promise<(StructuredAttentionRead & { scope: AgentSessionExecutionLocation })[]> {
  return database
    .read(async (read) => {
      const result: (StructuredAttentionRead & { scope: AgentSessionExecutionLocation })[] = []
      for (const record of conversations) {
        if (!agentSessionExecutionLocationsEqual(record.location, location)) {
          continue
        }
        try {
          const observedCursor = await readStoredJournalCursor(read, record.sessionId)
          if (observedCursor) {
            result.push({
              sessionId: record.sessionId,
              scope: { ...record.location },
              observedCursor
            })
          }
        } catch (error) {
          console.warn('[notifications] Could not capture workspace attention boundary', {
            sessionId: record.sessionId,
            error
          })
        }
      }
      return result
    })
    .catch((error: unknown) => {
      console.warn('[notifications] Could not capture workspace attention boundary', { error })
      return []
    })
}

/** Read coverage without opening or reducing a resting conversation. */
async function readStoredJournalCursor(
  db: JournalReadConnection,
  sessionId: string
): Promise<AgentJournalCursor | null> {
  const epoch = (
    await db.prepare('SELECT epoch FROM journal_sessions WHERE session_id = ?').get(sessionId)
  )?.epoch
  if (typeof epoch !== 'string') {
    return null
  }
  const source = await db.source(sessionId, epoch)
  const sequence = source
    ? source.through
    : ((
        await db
          .prepare('SELECT MAX(seq) AS seq FROM journal_rows WHERE session_id = ? AND epoch = ?')
          .get(sessionId, epoch)
      )?.seq ?? 0)
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new JournalOutcomeDecodeError('invalid journal cursor')
  }
  const boundary = source
    ? await db
        .prepare(`SELECT seq, field, entry_key, format, ordinal, value_json, deleted
          FROM journal_outcomes WHERE generation = ? AND field = '$' AND entry_key = ?
          AND seq <= ? ORDER BY seq DESC LIMIT 1`)
        .get(source.generation, JSON.stringify('contextBoundary'), source.through)
    : undefined
  const contextBoundary = boundary
    ? (decodingOutcome(() =>
        outcomeFormat1StoredScalars.shape.contextBoundary.parse(
          JSON.parse(decodeJournalOutcome(boundary).json)
        )
      ) ?? 1)
    : 1
  return journalContextCursor({ epoch, contextBoundary, lastSequence: sequence })
}
