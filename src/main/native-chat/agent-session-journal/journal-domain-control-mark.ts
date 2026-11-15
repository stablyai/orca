import type Database from '../../sqlite/sync-database'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalDomainControlCommit } from './journal-domain-control-command'
import { invalidateJournalDomainQueue } from './journal-domain-queue-revision'
import { appendJournalSqlEvent } from './journal-sql-event-tail'
type Target = { sessionId: string; epoch: string }

/** One event-only head mark; the receipt binds this command's last coordinate. */
export function writeJournalDomainControlMark(
  db: Database.Database,
  target: Target,
  fence: number,
  savedAt: number,
  result: JournalDomainControlCommit,
  write: (sequence: number) => void
): AgentJournalCursor {
  const sequence = result.cursor.sequence + 1
  write(sequence)
  invalidateJournalDomainQueue(db, target, sequence)
  appendJournalSqlEvent(
    db,
    target,
    sequence,
    savedAt,
    { items: [], submissions: [], cards: [] },
    { fence, observedAt: savedAt }
  )
  result.cursor = { epoch: target.epoch, sequence }
  result.coordinates.push({ kind: 'tombstone', epoch: target.epoch, seq: sequence })
  result.inputChanged = true
  return result.cursor
}
