import type Database from '../../sqlite/sync-database'
import type { JournalLifecycleBatchInput } from './journal-store-contracts'
import type { JournalDomainLifecycleCommit } from './journal-domain-lifecycle'
import { applyJournalDomainDispatch } from './journal-domain-dispatch'
import {
  readJournalDomainSubmissionAttempt,
  readJournalDomainSubmissionBody
} from './journal-domain-submission-records'
import { insertJournalDomainQueueRow, journalDomainQueueRow } from './journal-domain-queue-rows'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session/requests/agent-session-queued-submission'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { appendJournalSqlEvent } from './journal-sql-event-tail'

/** A failed start returns only the person's direct text; dispatch still owns its rejection. */
export function applyJournalDomainLifecycleDispatches(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  input: JournalLifecycleBatchInput,
  savedAt: number,
  result: JournalDomainLifecycleCommit
): boolean {
  const dispatches = input.rejectsQueued
    ? db
        .prepare(`SELECT payload_json FROM journal_submission_attempts WHERE session_id=? AND epoch=? AND current=1
      AND (dispatch_state='pending' OR (dispatch_state='unknown' AND recovered=0)) ORDER BY ordinal`)
        .all(target.sessionId, target.epoch)
        .map((row) => JSON.parse(String(row.payload_json)))
        .filter(isQueuedAgentJournalSubmission)
        .map((send) => ({
          clientMessageId: send.clientMessageId,
          fence: input.fence,
          state: 'rejected' as const,
          ...input.rejectsQueued!,
          recovered: true as const
        }))
    : [...(input.dispatches ?? [])]
  if (input.rejectsQueued && dispatches.length === 0) {
    return false
  }
  if (input.rejectsQueued && input.mutations.length === 0) {
    throw new Error('journal_lifecycle_batch_mutation_bound_exceeded')
  }
  let position =
    Math.min(
      0,
      Number(
        db
          .prepare(
            `SELECT MIN(position) AS position FROM journal_queue_cards WHERE session_id=? AND epoch=?`
          )
          .get(target.sessionId, target.epoch)?.position ?? 0
      )
    ) - dispatches.length
  for (let dispatch of dispatches) {
    if (input.keepFailedStart && dispatch.state === 'rejected') {
      const attempt = readJournalDomainSubmissionAttempt(db, target, dispatch.clientMessageId)
      const body = attempt && readJournalDomainSubmissionBody(db, target, dispatch.clientMessageId)
      const personal =
        attempt &&
        (attempt.admission.sourceKind === 'user' ||
          (attempt.admission.sourceKind === null && attempt.admission.origin === 'client'))
      if (
        attempt &&
        personal &&
        attempt.admission.familyId === null &&
        body?.kind === 'message' &&
        !body.command &&
        !journalDomainQueueRow(db, target, dispatch.clientMessageId)
      ) {
        const card = {
          messageId: dispatch.clientMessageId,
          body,
          position: position++,
          fingerprint: agentSessionSendBodyFingerprint(target.sessionId, body),
          state: 'returned' as const,
          holdReason: null,
          returnedReason: dispatch.reason,
          returnedRejection: dispatch.rejection,
          consumedAs: null,
          queuedAt: { epoch: target.epoch, sequence: attempt.submission.acceptedSequence ?? 0 },
          deliveryMode: 'queue' as const,
          unattended: !attempt.admittedPersonal,
          ...(attempt.admission.options ? { options: attempt.admission.options } : {})
        }
        insertJournalDomainQueueRow(db, target, card)
        const sequence = result.cursor.sequence + 1
        appendJournalSqlEvent(
          db,
          target,
          sequence,
          savedAt,
          { items: [], submissions: [], cards: [card.messageId] },
          { fence: input.fence, observedAt: savedAt }
        )
        result.cursor = { ...result.cursor, sequence }
        result.cards.push(card)
        result.inputChanged = true
        result.coordinates.push({ kind: 'queue', epoch: target.epoch, seq: sequence })
        dispatch = { ...dispatch, keptAsQueuedMessageId: dispatch.clientMessageId }
      }
    }
    const commit = applyJournalDomainDispatch(
      db,
      target,
      { kind: 'dispatch', input: dispatch },
      savedAt
    )
    result.cursor = { ...result.cursor, sequence: commit.cursor.sequence }
    result.items.push(...commit.items)
    result.receipts.push(...commit.receipts)
    result.cards.push(...commit.cards)
    result.removedItemIds.push(...commit.removedItemIds)
    result.inputChanged ||= commit.inputChanged
    if (commit.promptDispatches?.length) {
      result.promptDispatches ??= []
      result.promptDispatches.push(...commit.promptDispatches)
    }
    result.acceptedInputs = commit.acceptedInputs ?? result.acceptedInputs
    result.coordinates.push(
      ...commit.coordinates.map((position) => ({
        kind: position.kind === 'queue-reopen' ? ('tombstone' as const) : position.kind,
        epoch: target.epoch,
        seq: position.cursor.sequence
      }))
    )
  }
  return true
}
