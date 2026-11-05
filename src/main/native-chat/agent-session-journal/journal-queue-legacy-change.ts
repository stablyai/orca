import type Database from '../../sqlite/sync-database'
import type { JournalReadConnection } from './journal-sql-owner'
import { finishJournalStepsAsync } from './journal-reconstruction-steps'
import {
  LEGACY_QUEUED_MESSAGE_COLUMNS,
  readStoredQueuedMessageRow
} from './queued-message-stored-row'
import { dispatchWasWithdrawn } from '../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import { finishJournalSteps, sortJournalSteps } from './journal-reconstruction-steps'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { journalDispatchRowApplies, queuedHandOffInDoubt } from './journal-dispatch-settlement'
import type { JournalQueuedChange } from './journal-queue-events'
import { queuedCardFromChange } from './journal-queue-fold'
import { queuedChangeOf } from './journal-queue-retention'
import type { JournalReducerState } from './journal-reducer'
import { journalInputOrder } from './journal-input-order'
import {
  QUEUED_MESSAGE_HELD_DELIVERY_UNCONFIRMED,
  type QueuedMessageRow
} from './queued-message-table'

/** Preserve handoff links; copy refusals only when their original rows are no longer in this epoch. */
export function legacyQueuedChange(
  state: JournalReducerState,
  row: QueuedMessageRow
): JournalQueuedChange | null {
  return finishJournalSteps(legacyQueuedChangeSteps(state, row))
}

export function* legacyQueuedChangeSteps(
  state: JournalReducerState,
  row: QueuedMessageRow
): Generator<void, JournalQueuedChange | null> {
  const unconfirmed = row.state === 'waiting' ? yield* unconfirmedHandOffSteps(state, row) : null
  const attempt = row.state === 'waiting' ? (unconfirmed?.attempt ?? null) : row.consumedAs
  if (row.state === 'withdrawn' || (row.state === 'dispatched' && attempt === null)) {
    return null
  }
  const holdReason = unconfirmed?.holdReason ?? (row.state === 'waiting' ? row.holdReason : null)
  const change: JournalQueuedChange = {
    ...queuedChangeOf(row),
    ...(holdReason !== null ? { holdReason } : {}),
    ...(attempt !== null ? { attempt } : {}),
    ...(unconfirmed?.recovers ? { recovers: unconfirmed.recovers } : {}),
    ...(row.state === 'returned' && (attempt === null || !state.submissions.has(attempt))
      ? {
          returned: {
            reason: row.returnedReason,
            ...(row.returnedRejection ? { rejection: row.returnedRejection } : {})
          }
        }
      : {})
  }
  const card = queuedCardFromChange(state, row.messageId, change)
  return unanswered(card, state.submissions) ? change : null
}

/** Legacy refusals may have cleared handoff links without proving non-delivery.
 * Spend unchanged cards on uncertain attempts; edited/resubmitted cards require explicit Send. */
type UnconfirmedHandOff =
  | { attempt: string; holdReason?: undefined; recovers?: undefined }
  | { attempt?: undefined; holdReason: string; recovers?: string }
  | null

function* unconfirmedHandOffSteps(
  state: JournalReducerState,
  row: QueuedMessageRow
): Generator<void, UnconfirmedHandOff> {
  const attempts = yield* sortJournalSteps(
    journalInputOrder(state).linkedTo(row.messageId),
    (a, b) => (a.submittedSequence ?? 0) - (b.submittedSequence ?? 0)
  )
  let uncertain = false
  for (const attempt of attempts) {
    if (handOffInDoubt(attempt)) {
      uncertain = true
      break
    }
    yield
  }
  if (!uncertain) {
    return null
  }
  const latest = attempts.at(-1)!
  return handOffInDoubt(latest) && latest.payloadFingerprint === row.fingerprint
    ? { attempt: latest.clientMessageId }
    : {
        holdReason: QUEUED_MESSAGE_HELD_DELIVERY_UNCONFIRMED,
        ...(handOffInDoubt(latest) && (!dispatchWasWithdrawn(latest) || latest.answeredInTurn)
          ? { recovers: latest.clientMessageId }
          : {})
      }
}

export function handOffInDoubt(submission: AgentJournalSubmission): boolean {
  return queuedHandOffInDoubt(submission)
}

export function unanswered(
  card: QueuedMessageRow,
  submissions: ReadonlyMap<string, AgentJournalSubmission>
): boolean {
  if (card.state !== 'dispatched') {
    return card.state !== 'withdrawn'
  }
  const handOff = card.consumedAs === null ? undefined : submissions.get(card.consumedAs)
  return handOff === undefined || journalDispatchRowApplies(handOff) || handOffInDoubt(handOff)
}

export function readJournalLegacyCards(
  db: Database.Database,
  state: JournalReducerState
): QueuedMessageRow[] {
  return readLegacyRows(db, state.sessionId).flatMap((row) => {
    const change = legacyQueuedChange(state, row)
    return change ? [queuedCardFromChange(state, row.messageId, change)] : []
  })
}

function readLegacyRows(db: Database.Database, sessionId: string): QueuedMessageRow[] {
  return db
    .prepare(
      `SELECT ${LEGACY_QUEUED_MESSAGE_COLUMNS} FROM queued_messages WHERE session_id = ? ORDER BY position ASC`
    )
    .all(sessionId)
    .flatMap((row) => readStoredQueuedMessageRow(row) ?? [])
}

export async function readLegacyRowsAsync(
  read: JournalReadConnection,
  sessionId: string
): Promise<QueuedMessageRow[]> {
  const rows: QueuedMessageRow[] = []
  for await (const page of read.pages(
    `SELECT ${LEGACY_QUEUED_MESSAGE_COLUMNS} FROM queued_messages WHERE session_id = ? ORDER BY position ASC`,
    [sessionId]
  )) {
    for (const row of page) {
      const stored = readStoredQueuedMessageRow(row)
      if (stored) {
        rows.push(stored)
      }
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return rows
}

export async function readJournalLegacyCardsAsync(
  read: JournalReadConnection,
  state: JournalReducerState
): Promise<QueuedMessageRow[]> {
  const rows = await readLegacyRowsAsync(read, state.sessionId)
  function* convert(): Generator<void, QueuedMessageRow[]> {
    const cards: QueuedMessageRow[] = []
    for (const row of rows) {
      const change = yield* legacyQueuedChangeSteps(state, row)
      if (change) {
        cards.push(queuedCardFromChange(state, row.messageId, change))
      }
      yield
    }
    return cards
  }
  return finishJournalStepsAsync(convert())
}
