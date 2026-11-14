import { checkpointJournalRequestEvents } from './journal-writer-request-events'
import type Database from '../../sqlite/sync-database'
import { structuredMessageSteeringOptionsDiffer } from '../../../shared/agent-session/options/codex-message-compiler'
import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../shared/agent-session/requests/agent-session-queued-message-wire'
import type { JournalAutomaticSubmissionResult } from './journal-automatic-submission'
import { selectJournalAutomaticSubmission } from './journal-domain-automatic-selection'
import { applyJournalDomainSubmission } from './journal-domain-submission-admission'
import { applyJournalDomainQueueCommand } from './journal-domain-queue-command'
import { journalDomainEditLeaseDeadline } from './journal-domain-edit-leases'
import { JournalSqlScope } from './journal-sql-scope'
import { journalSqlFailure } from './journal-sql-failure'
import { finishJournalSqlCommand, journalSqlInputCoordinates } from './journal-sql-command-result'
import type { JournalWriterCommand } from './journal-writer-command'

/** SQL owns the selected card, its sparse intent and its conversion failure policy. */
export function applyJournalSqlAutomaticSubmissionCommand(
  db: Database.Database,
  stateDirectory: string,
  command: JournalWriterCommand & {
    operation: Extract<JournalWriterCommand['operation'], { kind: 'automatic-submission' }>
  },
  savedAt: number
) {
  const { target, operation, facts } = command
  const automatic = facts?.automatic
  if (!automatic) {
    throw new Error('automatic submission requires captured live facts')
  }
  const scope = new JournalSqlScope(db, target.sessionId, target.epoch)
  const { selection, selectionNow } = automatic
  const head = db
    .prepare('SELECT last_sequence FROM journal_chat_state WHERE session_id=? AND epoch=?')
    .get(...scope.prefix)!
  const empty = (value: JournalAutomaticSubmissionResult) =>
    finishJournalSqlCommand(
      db,
      stateDirectory,
      { ...command, effects: undefined },
      {
        cursor: { epoch: target.epoch, sequence: Number(head.last_sequence) },
        inputChanged: false,
        items: [],
        cards: [],
        receipts: [],
        editDeadline: journalDomainEditLeaseDeadline(db, target, selectionNow)
      },
      value,
      []
    )
  if (selection.authority.handle !== target.ownerToken) {
    return empty({ kind: 'waiting' })
  }
  const selected = selectJournalAutomaticSubmission(scope, selection, selectionNow, {
    reopenFloor: facts.reopenFloor ?? null,
    mail: facts.mail
  })
  if (selected.kind === 'needs-custody') {
    return empty({ kind: 'needs-custody', source: selected.source })
  }
  if (selected.card && selected.owed === 'stale') {
    return queueChange(
      { kind: 'queue-withdraw', messageIds: [selected.card.messageId], systemMail: true },
      { kind: 'withdrawn', messageId: selected.card.messageId }
    )
  }
  const { card, steer } = selected
  if (
    !card ||
    (steer &&
      (!selection.child?.ready ||
        selection.child.closing ||
        selection.child.stopping ||
        selected.command ||
        selection.child.fence !== operation.fence ||
        selection.authority.child?.fence !== selection.child.fence ||
        structuredMessageSteeringOptionsDiffer(selection.steering, card.options ?? undefined)))
  ) {
    return empty({ kind: 'waiting' })
  }
  const restoreRequestEvents = checkpointJournalRequestEvents(db)
  db.exec('SAVEPOINT journal_automatic_submission')
  try {
    const result = applyJournalDomainSubmission(
      db,
      stateDirectory,
      target,
      {
        kind: 'submission',
        input: {
          clientMessageId: operation.clientMessageId,
          fence: operation.fence,
          origin: 'host',
          handoverRecorded: true,
          queuedMessageId: card.messageId,
          body: card.body,
          payloadFingerprint: card.fingerprint,
          ...(card.options !== undefined ? { options: card.options } : {})
        }
      },
      facts,
      savedAt
    )
    const commit = finishJournalSqlCommand(
      db,
      stateDirectory,
      command,
      {
        ...result,
        editDeadline: journalDomainEditLeaseDeadline(db, target, selectionNow)
      },
      {
        kind: 'claimed',
        messageId: card.messageId,
        clientMessageId: operation.clientMessageId
      } satisfies JournalAutomaticSubmissionResult,
      journalSqlInputCoordinates(target.epoch, result.coordinates),
      result.items.map((item) => item.itemId)
    )
    db.exec('RELEASE journal_automatic_submission')
    return commit
  } catch (error) {
    db.exec('ROLLBACK TO journal_automatic_submission')
    restoreRequestEvents()
    db.exec('RELEASE journal_automatic_submission')
    return queueChange(
      {
        kind: 'queue-hold',
        messageIds: [card.messageId],
        reason: QUEUED_MESSAGE_PAUSED_SEND_FAILED
      },
      {
        kind: 'failed',
        messageId: card.messageId,
        failure: journalSqlFailure(error)
      }
    )
  }

  function queueChange(
    change: Extract<
      Parameters<typeof applyJournalDomainQueueCommand>[3],
      { kind: 'queue-hold' | 'queue-withdraw' }
    >,
    value: JournalAutomaticSubmissionResult
  ) {
    const result = applyJournalDomainQueueCommand(db, stateDirectory, target, change, savedAt)
    return finishJournalSqlCommand(
      db,
      stateDirectory,
      { ...command, effects: undefined },
      {
        ...result,
        items: [],
        receipts: [],
        editDeadline: journalDomainEditLeaseDeadline(db, target, selectionNow)
      },
      value,
      result.inputChanged
        ? [{ kind: 'queue', epoch: target.epoch, seq: result.cursor.sequence }]
        : []
    )
  }
}
