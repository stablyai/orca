import { memoryJournalMap } from '../journal-memory-collections'
import { orchestrationMailNotice } from '../../../../shared/agent-session/agent-session-message-source'
import type { QueuedMessageRow } from '../queued-messages/queued-message-table'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { LegacyQueueCardIndex } from './legacy-queue-card-index'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalReducerState } from '../projection/journal-reducer'
import type { JournalRow, JournalSubmissionRow } from '../durable-rows/journal-row-schema'
import type {
  JournalInputEntry,
  JournalInputCard,
  JournalInputLineageOwner
} from './journal-input-lineage'
import type { InputPlaceQuery } from './journal-input-place-index'

export type JournalInputPlace = JournalInputEntry & {
  coordinate: AgentJournalCursor
}

export function readJournalInputPlace(
  state: JournalReducerState,
  id: string
): JournalInputPlace | undefined {
  const own = state.inputEntries.get(id)
  const entry = state.submissions.get(id)
  if (!own || !entry) {
    return undefined
  }
  return {
    ...own,
    coordinate: {
      epoch: state.epoch,
      sequence: entry.acceptedSequence ?? entry.submittedSequence ?? 0
    }
  }
}
export function currentJournalInputIdentity(
  state: JournalReducerState,
  id: string,
  hasOverlay: () => boolean
): boolean {
  const card = state.queue.cards.get(id)
  return card
    ? card.state === 'waiting' ||
        card.state === 'returned' ||
        (card.state === 'dispatched' &&
          card.consumedAs !== null &&
          state.submissions.get(card.consumedAs)?.dispatchState === 'pending')
    : hasOverlay()
}

export function restoreJournalInputPlaces(state: JournalReducerState): void {
  for (const [id] of memoryJournalMap(state.inputEntries)) {
    if (state.submissions.get(id)?.dispatchState !== 'pending') {
      state.inputEntries.delete(id)
    }
  }
}

export function journalInputOrderChanged(
  state: JournalReducerState,
  row: JournalRow,
  readCount: (key: 'receiptCount' | 'queueRevision') => number
): boolean {
  return (
    row.kind === 'submission' ||
    row.kind === 'dispatch' ||
    row.kind === 'tombstone' ||
    readCount('receiptCount') !== state.receipts.size ||
    readCount('queueRevision') !== state.queue.revision
  )
}

export function isJournalInputOverride(
  entry: AgentJournalSubmission,
  recoveryPending: boolean
): boolean {
  return !recoveryPending && entry.origin === 'client' && entry.queuedMessageId !== undefined
}

export function recordJournalInputAdmission(
  state: JournalReducerState,
  row: JournalRow,
  cards: LegacyQueueCardIndex,
  releasePlace: (id: string) => void
): void {
  if (row.kind !== 'submission' || !row.handoverRecorded || row.queuedMessageId !== undefined) {
    return
  }
  if (state.inputEntries.has(row.clientMessageId)) {
    if (
      state.submissions.has(row.clientMessageId) &&
      !state.items.has(agentJournalSubmissionKey(row.clientMessageId))
    ) {
      releasePlace(row.clientMessageId)
    } else {
      return
    }
  }
  const place = cards.admission(state, row)
  state.inputEntries.set(row.clientMessageId, {
    context: place.context,
    ...(place.witnessCardId ? { witnessCardId: place.witnessCardId } : {})
  })
}

export function readJournalInputAdmission(
  row: JournalSubmissionRow,
  cards: LegacyQueueCardIndex,
  cut: number
): JournalInputPlace {
  const coordinate = { epoch: row.epoch, sequence: row.seq }
  const context = row.inputOrderContext
    ? { ...row.inputOrderContext, basis: 'observed' as const }
    : { source: coordinate, basis: 'observed' as const, cut }
  const place: JournalInputPlace = { coordinate, context }
  const selected = cards.query(place).command
  return { ...place, ...(selected ? { witnessCardId: selected.messageId } : {}) }
}

export function releaseJournalInputHistory(
  state: JournalReducerState,
  lineage: JournalInputLineageOwner,
  cards: LegacyQueueCardIndex
): void {
  lineage.releaseHistory((id) => {
    const keep = currentJournalInputIdentity(state, id, () => cards.hasOverlay(id))
    if (!keep) {
      cards.releaseCard(id)
    }
    return keep
  })
}

export function journalInputCardPrecedes(
  lineage: JournalInputCard | undefined,
  place: JournalInputPlace
): boolean {
  return lineage !== undefined && lineage.introduced < place.context.cut
}

export function gateJournalInputPlaces(result: InputPlaceQuery, failed: boolean): InputPlaceQuery {
  if (!failed) {
    return result
  }
  const { head, handoff, position } = result
  return { ...(head ? { head } : {}), ...(handoff ? { handoff } : {}), position }
}

export function sameJournalInputCardPlace(
  prior: QueuedMessageRow,
  card: QueuedMessageRow
): boolean {
  return (
    prior.position === card.position &&
    prior.state === card.state &&
    prior.holdReason === card.holdReason &&
    prior.consumedAs === card.consumedAs &&
    prior.queuedAt?.epoch === card.queuedAt?.epoch &&
    prior.queuedAt?.sequence === card.queuedAt?.sequence &&
    Boolean(prior.body.command) === Boolean(card.body.command) &&
    !!orchestrationMailNotice(prior.body.from) === !!orchestrationMailNotice(card.body.from)
  )
}
