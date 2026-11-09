import type Database from '../../sqlite/sync-database'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalWriterCommand } from './journal-writer-command'
import { applyJournalSqlEditLeaseCommand } from './journal-sql-edit-lease-command'
import { applyJournalDomainInputRecovery } from './journal-domain-input-recovery'
import { applyJournalDomainControlCommand } from './journal-domain-control-command'
import { journalDomainQueueAwaitsReopen } from './journal-domain-queue-reads'
import { finishJournalSqlCommand } from './journal-sql-command-result'
import { checkpointJournalRequestEvents } from './journal-writer-request-events'
import { journalSqlFailure, type JournalSqlFailure } from './journal-sql-failure'

export type JournalOpenRecoveryResult = {
  failures: {
    step: 'pending-unknown' | 'hold-unsent' | 'queue-reopen'
    failure: JournalSqlFailure
  }[]
  reopenFloor: AgentJournalCursor | null
}

/** Opening recovers journal-only obligations at the same writer position, before any reader. */
export function applyJournalSqlOpenCommand(
  db: Database.Database,
  stateDirectory: string,
  command: JournalWriterCommand & {
    operation: Extract<JournalWriterCommand['operation'], { kind: 'open' }>
  },
  savedAt: number
) {
  const opened = applyJournalSqlEditLeaseCommand(db, stateDirectory, command, savedAt)
  const { recover } = command.operation
  if (!recover) {
    return opened
  }
  const { target } = command
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: open returns its physical pre-recovery cursor.
  const openedThrough = opened.value as AgentJournalCursor
  const recovery: JournalOpenRecoveryResult = { failures: [], reopenFloor: null }
  const attempt = <Value>(
    step: JournalOpenRecoveryResult['failures'][number]['step'],
    run: () => Value
  ) => {
    const restoreEvents = checkpointJournalRequestEvents(db)
    db.exec('SAVEPOINT journal_open_recovery')
    try {
      const value = run()
      db.exec('RELEASE journal_open_recovery')
      return value
    } catch (error) {
      db.exec('ROLLBACK TO journal_open_recovery; RELEASE journal_open_recovery')
      restoreEvents()
      recovery.failures.push({ step, failure: journalSqlFailure(error) })
      return undefined
    }
  }
  for (const kind of ['pending-unknown', 'hold-unsent'] as const) {
    const result = attempt(kind, () =>
      applyJournalDomainInputRecovery(
        db,
        target,
        kind === 'pending-unknown'
          ? { kind, fence: recover.fence }
          : { kind, fence: recover.fence, hold: { cause: 'hostRestarted' } },
        { openedThrough },
        savedAt
      )
    )
    if (result && 'failure' in result.value) {
      recovery.failures.push({ step: kind, failure: result.value.failure })
    }
  }
  attempt('queue-reopen', () => {
    if (journalDomainQueueAwaitsReopen(db, target)) {
      const head = db
        .prepare('SELECT last_sequence FROM journal_chat_state WHERE session_id=? AND epoch=?')
        .get(target.sessionId, target.epoch)!
      recovery.reopenFloor = { epoch: target.epoch, sequence: Number(head.last_sequence) + 1 }
      applyJournalDomainControlCommand(
        db,
        target,
        { kind: 'queue-reopen-mark', fence: recover.fence },
        {},
        savedAt
      )
      recovery.reopenFloor = null
    }
  })
  const head = db
    .prepare('SELECT last_sequence FROM journal_chat_state WHERE session_id=? AND epoch=?')
    .get(target.sessionId, target.epoch)!
  const sequence = Number(head.last_sequence)
  return {
    ...finishJournalSqlCommand(
      db,
      stateDirectory,
      command,
      {
        cursor: { epoch: target.epoch, sequence },
        inputChanged: opened.inputChanged || sequence !== openedThrough.sequence,
        items: [],
        cards: [],
        receipts: [],
        editDeadline: opened.publication?.editDeadline
      },
      openedThrough,
      []
    ),
    openRecovery: recovery
  }
}
