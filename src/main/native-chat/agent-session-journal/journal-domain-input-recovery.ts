import { checkpointJournalRequestEvents } from './journal-writer-request-events'
import type Database from '../../sqlite/sync-database'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session/requests/agent-session-queued-submission'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type { JournalWriterOperation } from './journal-writer-command'
import type { ResolveDispatchInput } from './journal-store-contracts'
import { journalSubmissionSelected } from './journal-submission-selector'
import { journalPendingSubmissionResolutions } from './submissions/journal-pending-submission-recovery'
import {
  isUnansweredHandedOverSubmission,
  unsentSendKeptAsCard
} from './queued-messages/journal-unsent-send-hold'
import { DISPATCH_DOUBT_HOST_RESTARTED } from './projection/journal-dispatch-doubt-reasons'
import { applyJournalDomainDispatch } from './journal-domain-dispatch'
import {
  readJournalDomainSubmissionAttempt,
  readJournalDomainSubmissionBody,
  type JournalDomainSubmissionTarget
} from './journal-domain-submission-records'
import { insertJournalDomainQueueRow, journalDomainQueueRow } from './journal-domain-queue-rows'
import {
  journalDomainInputCommit,
  appendJournalDomainInputCommit,
  type JournalDomainInputCommit
} from './journal-domain-input-commit'
import { appendJournalSqlEvent } from './journal-sql-event-tail'
import { journalSqlFailure } from './journal-sql-failure'

export type JournalDomainInputRecoveryOperation = Extract<
  JournalWriterOperation,
  { kind: 'pending-unknown' | 'pending-reject' | 'queued-reject' | 'hold-unsent' }
>

export type JournalDomainInputRecoveryFacts = {
  /** Physical admission boundary captured once before this opening's recovery writes. */
  openedThrough?: AgentJournalCursor
}

type Recoverable = { submission: AgentJournalSubmission; attemptSequence: number }

/** Pages only actual current recovery obligations, never settled attempts or chat history. */
function recoverableSubmissions(
  db: Database.Database,
  target: JournalDomainSubmissionTarget
): Recoverable[] {
  const selected: Recoverable[] = []
  let after: { ordinal: number; messageId: string } | undefined
  for (;;) {
    const page = db
      .prepare(`SELECT ordinal,message_id,attempt_sequence,payload_json
        FROM journal_submission_attempts INDEXED BY journal_submission_recovery
        WHERE session_id=? AND epoch=? AND current=1
          AND (dispatch_state='pending' OR (dispatch_state='unknown' AND recovered=0))
          ${after ? 'AND (ordinal,message_id)>(?,?)' : ''}
        ORDER BY ordinal,message_id LIMIT 64`)
      .all(target.sessionId, target.epoch, ...(after ? [after.ordinal, after.messageId] : []))
    for (const row of page) {
      selected.push({
        submission: JSON.parse(String(row.payload_json)),
        attemptSequence: Number(row.attempt_sequence)
      })
      after = { ordinal: Number(row.ordinal), messageId: String(row.message_id) }
    }
    if (page.length < 64) {
      return selected
    }
  }
}

/** The writer owns the transaction; a failed send never rolls back an earlier settlement. */
export function applyJournalDomainInputRecovery(
  db: Database.Database,
  target: JournalDomainSubmissionTarget,
  operation: JournalDomainInputRecoveryOperation,
  facts: JournalDomainInputRecoveryFacts,
  savedAt: number
): JournalDomainInputCommit<string[] | number | null> {
  if (!db.isTransaction) {
    throw new Error('journal input recovery requires its writer transaction')
  }
  const head = db
    .prepare('SELECT last_sequence FROM journal_chat_state WHERE session_id=? AND epoch=?')
    .get(target.sessionId, target.epoch)
  if (!head) {
    throw new Error('journal input recovery targets a retired chat epoch')
  }
  const cursor = { epoch: target.epoch, sequence: Number(head.last_sequence) }
  const result = journalDomainInputCommit<string[] | number | null>(
    cursor,
    operation.kind === 'hold-unsent' ? null : []
  )
  const selected = recoverableSubmissions(db, target)
  if (operation.kind === 'hold-unsent') {
    return holdUnsent(db, target, operation, facts, savedAt, selected, result)
  }
  const submissions = selected.map((entry) => entry.submission)
  const resolutions =
    operation.kind === 'queued-reject'
      ? submissions
          .filter(
            (entry) =>
              isQueuedAgentJournalSubmission(entry) &&
              (!operation.select ||
                journalSubmissionSelected(operation.select, () => cursor)(entry))
          )
          .map((entry): ResolveDispatchInput => ({
            clientMessageId: entry.clientMessageId,
            state: 'rejected',
            ...operation.rejection,
            fence: operation.fence,
            recovered: true
          }))
      : journalPendingSubmissionResolutions(
          submissions,
          operation.fence,
          operation.kind === 'pending-reject'
            ? { rejection: operation.rejection }
            : { reason: operation.reason ?? DISPATCH_DOUBT_HOST_RESTARTED }
        )
  let failure: unknown
  for (const input of resolutions) {
    const restoreRecoveryEvents = checkpointJournalRequestEvents(db)
    db.exec('SAVEPOINT journal_recovery_send')
    try {
      const commit = applyJournalDomainDispatch(db, target, { kind: 'dispatch', input }, savedAt)
      db.exec('RELEASE journal_recovery_send')
      appendJournalDomainInputCommit(result, commit)
    } catch (error) {
      db.exec('ROLLBACK TO journal_recovery_send; RELEASE journal_recovery_send')
      restoreRecoveryEvents()
      failure ??= error
      // Queued withdrawals were issued together; pending recovery awaited each send in order.
      if (operation.kind !== 'queued-reject') {
        break
      }
    }
  }
  result.value = failure
    ? { failure: journalSqlFailure(failure) }
    : { value: resolutions.map((input) => input.clientMessageId) }
  return result
}

function holdUnsent(
  db: Database.Database,
  target: JournalDomainSubmissionTarget,
  operation: Extract<JournalDomainInputRecoveryOperation, { kind: 'hold-unsent' }>,
  facts: JournalDomainInputRecoveryFacts,
  savedAt: number,
  selected: readonly Recoverable[],
  result: JournalDomainInputCommit<string[] | number | null>
): typeof result {
  const { hold, unrun } = operation
  if (!unrun && hold.cause === 'hostRestarted' && !facts.openedThrough) {
    throw new Error('journal restart recovery requires its captured opening boundary')
  }
  const batch = selected
    .filter(({ submission, attemptSequence }) =>
      unrun
        ? isUnansweredHandedOverSubmission(submission) &&
          (unrun === true || journalSubmissionSelected(unrun, () => result.cursor)(submission))
        : isQueuedAgentJournalSubmission(submission) &&
          (hold.cause === 'hostRestarted'
            ? facts.openedThrough!.epoch === target.epoch &&
              attemptSequence <= facts.openedThrough!.sequence
            : !hold.select ||
              journalSubmissionSelected(hold.select, () => result.cursor)(submission))
    )
    .sort((a, b) => (a.submission.acceptedSequence ?? 0) - (b.submission.acceptedSequence ?? 0))
  if (batch.length === 0) {
    return result
  }
  const first = db
    .prepare(
      'SELECT MIN(position) AS position FROM journal_queue_cards WHERE session_id=? AND epoch=?'
    )
    .get(target.sessionId, target.epoch)
  let position = Math.min(0, Number(first?.position ?? 0)) - batch.length
  const rejection = agentSessionFailureWords(agentSessionFailureFact(hold.cause), {
    surface: 'rejection'
  })
  const failures: unknown[] = []
  for (const { submission } of batch) {
    const restoreUnsentEvents = checkpointJournalRequestEvents(db)
    db.exec('SAVEPOINT journal_unsent_send')
    try {
      const attempt = readJournalDomainSubmissionAttempt(db, target, submission.clientMessageId)
      if (!attempt) {
        throw new Error('journal recovery lost its selected current attempt')
      }
      const body = unsentSendKeptAsCard(
        {
          ...submission,
          // Admission source and family remain authoritative after presentation normalization.
          queuedMessageId: attempt.admission.familyId ?? undefined,
          origin: attempt.admission.origin ?? undefined,
          source:
            attempt.admission.sourceKind === null
              ? undefined
              : { kind: attempt.admission.sourceKind }
        },
        attempt.admission.body ??
          readJournalDomainSubmissionBody(db, target, submission.clientMessageId)
      )
      const step = journalDomainInputCommit(result.cursor, undefined)
      if (body && !journalDomainQueueRow(db, target, submission.clientMessageId)) {
        const card = {
          messageId: submission.clientMessageId,
          body,
          position: position++,
          fingerprint: agentSessionSendBodyFingerprint(target.sessionId, body),
          state: 'waiting' as const,
          holdReason: null,
          returnedReason: null,
          returnedRejection: null,
          consumedAs: null,
          queuedAt: { epoch: target.epoch, sequence: submission.submittedSequence ?? 0 },
          deliveryMode: 'queue' as const,
          unattended: !attempt.admittedPersonal,
          ...(attempt.admission.options ? { options: attempt.admission.options } : {})
        }
        insertJournalDomainQueueRow(db, target, card)
        const sequence = step.cursor.sequence + 1
        appendJournalSqlEvent(
          db,
          target,
          sequence,
          savedAt,
          {
            items: [],
            submissions: [],
            cards: [card.messageId]
          },
          { fence: operation.fence, observedAt: savedAt }
        )
        step.cursor = { epoch: target.epoch, sequence }
        step.cards.push(card)
        step.inputChanged = true
        step.coordinates.push({
          kind: 'queue',
          cursor: step.cursor,
          fence: operation.fence,
          observedAt: savedAt
        })
      }
      const commit = applyJournalDomainDispatch(
        db,
        target,
        {
          kind: 'dispatch',
          input: {
            clientMessageId: submission.clientMessageId,
            state: 'rejected',
            ...rejection,
            ...(unrun ? { rejection: { ...rejection.rejection, neverReachedAgent: true } } : {}),
            fence: operation.fence,
            recovered: true,
            ...(body ? { keptAsQueuedMessageId: submission.clientMessageId } : {})
          }
        },
        savedAt
      )
      appendJournalDomainInputCommit(step, commit)
      db.exec('RELEASE journal_unsent_send')
      appendJournalDomainInputCommit(result, step)
    } catch (error) {
      db.exec('ROLLBACK TO journal_unsent_send; RELEASE journal_unsent_send')
      restoreUnsentEvents()
      failures.push(error)
    }
  }
  result.value = failures.length
    ? { failure: journalSqlFailure(new AggregateError(failures, 'settling unsent sends failed')) }
    : { value: batch.at(-1)?.submission.acceptedSequence ?? 0 }
  return result
}
