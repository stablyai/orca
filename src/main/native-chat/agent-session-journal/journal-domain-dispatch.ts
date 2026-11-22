import type Database from '../../sqlite/sync-database'
import { JournalSqlScope } from './journal-sql-scope'
import { journalDomainSubmission } from './journal-domain-status-inputs'
import { refreshJournalDomainAcceptedHandover } from './journal-domain-input-ends'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalAcceptanceReceipt } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { dispatchWasWithdrawn } from '../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import { structuredAgentSessionCommandTurnIdentity } from '../../../shared/agent-session/view/structured-agent-session-command-turn-identity'
import type { JournalWriterOperation } from './journal-writer-command'
import {
  readJournalDomainSubmissionAttempt,
  type JournalDomainSubmissionCommit,
  type JournalDomainSubmissionTarget
} from './journal-domain-submission-records'
import {
  placeJournalDomainDispatchItem,
  readJournalDomainDispatchItem
} from './journal-domain-dispatch-placement'
import { readJournalDomainTurnScope } from './journal-domain-turn-scope'
import { journalDomainQueueRow, replaceJournalDomainQueueRow } from './journal-domain-queue-rows'
import {
  retireJournalDomainEditHolds,
  journalDomainEditLeaseDeadline
} from './journal-domain-edit-leases'
import { readJournalSqlAcceptedInputs } from './journal-sql-accepted-inputs'
import { appendJournalSqlEvent } from './journal-sql-event-tail'
import { assertJournalFence } from './writing/journal-write-guards'
import {
  journalDispatchRowApplies,
  queuedHandOffInDoubt,
  queuedHandOffOutcome
} from './projection/journal-dispatch-settlement'
import { foldQueuedHandOffInDoubt } from './submissions/journal-submission-fold'
import { rejectedCardTransition } from './queued-messages/journal-queue-fold'
import {
  journalDomainDispatchInput,
  settledJournalDomainSubmission,
  latestJournalDomainFamilyAttempt,
  writeJournalDomainDispatchAttempt
} from './journal-domain-dispatch-attempt'

export type JournalDomainDispatchOperation = Extract<
  JournalWriterOperation,
  { kind: 'dispatch' | 'accept-late' | 'late-dispatch' }
>

/** Settlement reads the actual current attempt/card; callers own its surrounding SAVEPOINT. */
export function applyJournalDomainDispatch(
  db: Database.Database,
  target: JournalDomainSubmissionTarget,
  operation: JournalDomainDispatchOperation,
  savedAt: number
): JournalDomainSubmissionCommit {
  if (!db.isTransaction) {
    throw new Error('journal dispatch requires its writer transaction')
  }
  const prefix = [target.sessionId, target.epoch] as const
  const head = db
    .prepare(`SELECT last_sequence,highest_fence FROM journal_chat_state
    WHERE session_id=? AND epoch=?`)
    .get(...prefix)
  if (!head) {
    throw new Error('journal dispatch targets a retired chat epoch')
  }
  const cursor = { epoch: target.epoch, sequence: Number(head.last_sequence) }
  const attempt = readJournalDomainSubmissionAttempt(
    db,
    target,
    operation.input.clientMessageId,
    operation.input.state === 'pending'
  )
  const applies = journalDispatchRowApplies(attempt?.submission)
  const lateAccepted =
    operation.kind === 'accept-late' ||
    (operation.kind === 'late-dispatch' && operation.input.state === 'accepted')
  const skip =
    !applies && (lateAccepted || (operation.kind === 'dispatch' && operation.onlyIfUnsettled))
  const result: JournalDomainSubmissionCommit = {
    cursor,
    value: operation.kind === 'dispatch' ? null : undefined,
    coordinates: [],
    items: [],
    removedItemIds: [],
    receipts: [],
    cards: [],
    inputChanged: false
  }
  if (skip) {
    return result
  }
  const input = journalDomainDispatchInput(operation, attempt?.submission)
  assertJournalFence(input.fence, Number(head.highest_fence))
  const sequence = cursor.sequence + 1
  const nextCursor = { epoch: target.epoch, sequence }
  if (applies && attempt) {
    const itemId = agentJournalSubmissionKey(input.clientMessageId)
    const previous = readJournalDomainDispatchItem(db, target, itemId)
    const next = settledJournalDomainSubmission(attempt.submission, input, savedAt)
    let handover = attempt.handover
    let handoverPlace = attempt.handoverPlace
    let carries = attempt.carries
    let rejection = attempt.rejection
    let presentationMember = attempt.presentationMember
    let normalizedHandOff = attempt.normalizedHandOff
    let place: Parameters<typeof placeJournalDomainDispatchItem>[3] = null
    if (input.state === 'pending') {
      let scope = input.turnScope
      const body =
        attempt.admission.body ??
        (previous?.item.body.kind === 'message' ? previous.item.body : null)
      const derived = body && readJournalDomainTurnScope(db, target, body)
      if (scope.kind !== 'turn' && derived?.kind === 'turn') {
        const turn = readJournalDomainDispatchItem(db, target, derived.turnItemId)
        if (readAgentJournalTurn(turn?.item.body)?.state === 'running') {
          scope = derived
        }
      }
      handover = {
        sequence,
        at: savedAt,
        fence: input.fence,
        scope,
        ...(input.recovered ? { recovered: true as const } : {})
      }
      carries = (input.carries ?? []).filter((id) => id.length > 0)
      if (next.handoverRecorded && previous) {
        place = { sequence, observedAt: savedAt, turnScope: input.turnScope }
        if (next.queuedMessageId !== undefined) {
          handoverPlace = { sequence, at: savedAt, scope: input.turnScope }
        }
      }
    } else if (input.state === 'rejected' && previous) {
      place = { sequence, observedAt: savedAt, turnScope: { kind: 'thread' } }
    }
    const card =
      next.queuedMessageId === undefined
        ? null
        : journalDomainQueueRow(db, target, next.queuedMessageId)
    const linkedCard =
      card?.card.state === 'dispatched' && card.card.consumedAs === input.clientMessageId
        ? card
        : null
    if (linkedCard && next.dispatchState === 'rejected') {
      const reported =
        db
          .prepare(`SELECT 1 FROM journal_items WHERE session_id=? AND epoch=? AND item_id=?`)
          .get(
            ...prefix,
            agentJournalItemKey(structuredAgentSessionCommandTurnIdentity(input.clientMessageId))
          ) !== undefined
      const settled = rejectedCardTransition(linkedCard.card, next, reported)
      if (settled !== linkedCard.card) {
        replaceJournalDomainQueueRow(db, target, linkedCard, settled)
        result.cards.push(settled)
        if (retireJournalDomainEditHolds(db, target, [settled.messageId])) {
          result.editDeadline = journalDomainEditLeaseDeadline(db, target, savedAt)
        }
      }
    }
    if (
      input.state === 'rejected' &&
      attempt.admission.familyId !== null &&
      queuedHandOffOutcome(next) === 'inDoubt'
    ) {
      rejection = {
        sequence,
        at: savedAt,
        fence: input.fence,
        reason: next.reason,
        fact: next.rejection ?? null,
        recovered: Boolean(input.recovered),
        keptMessageId: input.keptAsQueuedMessageId ?? null,
        answeredInTurn: next.answeredInTurn ?? null
      }
      normalizedHandOff = true
      foldQueuedHandOffInDoubt(next)
    }
    if (linkedCard && queuedHandOffInDoubt(next)) {
      presentationMember = true
      normalizedHandOff = true
      if (handoverPlace && previous) {
        place = {
          sequence: handoverPlace.sequence,
          observedAt: handoverPlace.at,
          turnScope: handoverPlace.scope
        }
      }
      if (dispatchWasWithdrawn(next) && !next.answeredInTurn) {
        delete next.queuedMessageId
      }
    }
    const candidate =
      (next.dispatchState === 'pending' || next.dispatchState === 'unknown') &&
      latestJournalDomainFamilyAttempt(
        db,
        target,
        attempt.admission.familyId,
        input.clientMessageId
      )
    writeJournalDomainDispatchAttempt(db, target, {
      ...attempt,
      submission: next,
      candidate,
      handover,
      handoverPlace,
      carries,
      rejection,
      presentationMember,
      normalizedHandOff
    })
    if (previous) {
      const hidden =
        rejection !== null && !presentationMember
          ? true
          : attempt.rejection !== null && !attempt.presentationMember && presentationMember
            ? false
            : previous.hidden
      result.items = placeJournalDomainDispatchItem(db, target, previous, place, hidden)
      if (hidden) {
        result.removedItemIds.push(itemId)
        result.items = result.items.filter((item) => item.itemId !== itemId)
      }
    }
    if (input.state === 'accepted') {
      refreshJournalDomainAcceptedHandover(db, target, itemId)
    }
    if (input.state === 'accepted' && next.providerItemId) {
      db.prepare(`INSERT INTO journal_item_aliases(session_id,epoch,provider_item_id,item_id) VALUES(?,?,?,?)
        ON CONFLICT(session_id,epoch,provider_item_id) DO UPDATE SET item_id=excluded.item_id`).run(
        ...prefix,
        next.providerItemId,
        itemId
      )
      const receipt: AgentJournalAcceptanceReceipt = {
        clientMessageId: input.clientMessageId,
        providerItemId: next.providerItemId,
        cursor: nextCursor,
        acceptedAt: savedAt
      }
      db.prepare(`INSERT INTO journal_send_receipts(session_id,epoch,message_id,cursor_sequence,payload_json) VALUES(?,?,?,?,?)
        ON CONFLICT(session_id,epoch,message_id) DO UPDATE SET cursor_sequence=excluded.cursor_sequence,payload_json=excluded.payload_json`).run(
        ...prefix,
        input.clientMessageId,
        receipt.cursor.sequence,
        JSON.stringify(receipt)
      )
      result.receipts.push(receipt)
    }
    result.inputChanged = true
    if (input.state === 'accepted') {
      result.acceptedInputs = readJournalSqlAcceptedInputs(db, prefix)
    }
  }
  appendJournalSqlEvent(
    db,
    target,
    sequence,
    savedAt,
    {
      items: result.items.map((item) => ({
        itemId: item.itemId,
        revision: item.revision,
        sequence: item.sequence,
        sequenceIndex: item.sequenceIndex ?? 0
      })),
      submissions: applies ? [input.clientMessageId] : [],
      cards: result.cards.map((card) => card.messageId),
      ...(result.removedItemIds.length ? { removedItemIds: result.removedItemIds } : {})
    },
    { fence: input.fence, observedAt: savedAt }
  )
  result.cursor = nextCursor
  if (operation.kind === 'dispatch') {
    result.value = nextCursor
  }
  result.coordinates.push({
    kind: 'dispatch',
    cursor: nextCursor,
    fence: input.fence,
    observedAt: savedAt,
    clientMessageId: input.clientMessageId
  })
  const current = journalDomainSubmission(
    new JournalSqlScope(db, target.sessionId, target.epoch),
    input.clientMessageId
  )
  result.promptDispatches = [
    {
      clientMessageId: input.clientMessageId,
      state: input.state,
      ...(current?.queuedMessageId ? { queuedMessageId: current.queuedMessageId } : {})
    }
  ]
  return result
}
