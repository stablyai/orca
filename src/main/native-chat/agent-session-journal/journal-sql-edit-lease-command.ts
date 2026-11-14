import type Database from '../../sqlite/sync-database'
import { applyJournalDomainEditLease } from './journal-domain-edit-leases'
import type { JournalWriterCommand } from './journal-writer-command'
import type { JournalWriterCommit } from './journal-writer-changes'
import { appendJournalSqlEvent } from './journal-sql-event-tail'
import { finishJournalSqlCommand } from './journal-sql-command-result'
import { invalidateJournalDomainQueue } from './journal-domain-queue-revision'

export function applyJournalSqlEditLeaseCommand(
  db: Database.Database,
  stateDirectory: string,
  command: JournalWriterCommand & {
    operation: Extract<JournalWriterCommand['operation'], { kind: 'edit-lease' | 'open' }>
  },
  savedAt: number
): JournalWriterCommit {
  if (command.effects?.length) {
    throw new Error('edit holds carry no operation receipt')
  }
  const { target, operation } = command
  const head = db
    .prepare('SELECT last_sequence FROM journal_chat_state WHERE session_id=? AND epoch=?')
    .get(target.sessionId, target.epoch)
  if (!head) {
    throw new Error('edit hold targets a retired chat epoch')
  }
  const outcome = applyJournalDomainEditLease(
    db,
    target,
    target.ownerToken,
    operation.kind === 'open' ? { kind: 'expire' } : operation.operation,
    savedAt
  )
  const sequence = Number(head.last_sequence) + (outcome.changed ? 1 : 0)
  if (outcome.changed) {
    invalidateJournalDomainQueue(db, target, sequence)
    appendJournalSqlEvent(db, target, sequence, savedAt, {
      items: [],
      submissions: [],
      cards: []
    })
  }
  return finishJournalSqlCommand(
    db,
    stateDirectory,
    command,
    {
      cursor: { epoch: target.epoch, sequence },
      items: [],
      cards: [],
      receipts: [],
      inputChanged: outcome.changed,
      editDeadline: outcome.nextDeadline
    },
    operation.kind === 'open'
      ? { epoch: target.epoch, sequence: Number(head.last_sequence) }
      : outcome,
    []
  )
}
