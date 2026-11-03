import type { QueuedMessageRow } from './queued-message-table'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalInputCardIndex } from './journal-input-card-index'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow, JournalSubmissionRow } from './journal-row-schema'
import {
  queryInputContext,
  type JournalInputEntry,
  type JournalInputCard,
  type JournalInputLineageOwner
} from './journal-input-lineage'
import {
  mergeInputPlaces,
  type InputPlaceQuery,
  type JournalInputPlaceIndex
} from './journal-input-place-index'

export type JournalInputPlace = JournalInputEntry & {
  coordinate: AgentJournalCursor
  original?: AgentJournalCursor
}

export function readJournalInputPlace(
  state: JournalReducerState,
  id: string,
  originals: Map<string, AgentJournalCursor | undefined>,
  originalAcceptance?: (id: string) => AgentJournalCursor | undefined
): JournalInputPlace | undefined {
  const own = state.inputEntries.get(id)
  const entry = state.submissions.get(id)
  if (!own || !entry) {
    return undefined
  }
  if (own.context.basis === 'legacy' && !originals.has(id)) {
    originals.set(id, originalAcceptance?.(id))
  }
  const original = originals.get(id)
  return {
    ...own,
    coordinate: {
      epoch: state.epoch,
      sequence: entry.acceptedSequence ?? entry.submittedSequence ?? 0
    },
    ...(original ? { original } : {})
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

export function restoreJournalInputPlaces(state: JournalReducerState): number {
  let legacyPlaces = 0
  for (const [id, own] of state.inputEntries) {
    if (state.submissions.get(id)?.dispatchState !== 'pending') {
      state.inputEntries.delete(id)
    } else if (own.context.basis === 'legacy') {
      legacyPlaces++
    }
  }
  return legacyPlaces
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
  cards: JournalInputCardIndex,
  originalAcceptance: ((id: string) => AgentJournalCursor | undefined) | undefined,
  releasePlace: (id: string) => void
): boolean {
  if (row.kind !== 'submission' || !row.handoverRecorded || row.queuedMessageId !== undefined) {
    return false
  }
  if (state.inputEntries.has(row.clientMessageId)) {
    if (
      state.submissions.has(row.clientMessageId) &&
      !state.items.has(agentJournalSubmissionKey(row.clientMessageId))
    ) {
      releasePlace(row.clientMessageId)
    } else {
      return false
    }
  }
  const place = cards.admission(state, row, originalAcceptance)
  state.inputEntries.set(row.clientMessageId, {
    context: place.context,
    ...(place.witnessCardId ? { witnessCardId: place.witnessCardId } : {})
  })
  return place.context.basis === 'legacy'
}

export function readJournalInputAdmission(
  row: JournalSubmissionRow,
  cards: JournalInputCardIndex,
  cut: number,
  originalAcceptance?: (id: string) => AgentJournalCursor | undefined
): JournalInputPlace {
  const coordinate = { epoch: row.epoch, sequence: row.seq }
  const context = row.inputOrderContext ?? {
    source: coordinate,
    basis: 'legacy' as const,
    cut
  }
  const original =
    context.basis === 'legacy' ? originalAcceptance?.(row.clientMessageId) : undefined
  const place: JournalInputPlace = { coordinate, context, ...(original ? { original } : {}) }
  const exposed = row.inputOrderContext?.basis === 'legacy' ? cards.command() : undefined
  const selected =
    row.inputOrderContext?.basis === 'legacy'
      ? exposed && cards.relation(exposed, place)
        ? exposed
        : undefined
      : !row.inputOrderContext
        ? cards.queryCurrent(place).command
        : cards.query(place).command
  return { ...place, ...(selected ? { witnessCardId: selected.messageId } : {}) }
}

export function releaseJournalInputHistory(
  state: JournalReducerState,
  lineage: JournalInputLineageOwner,
  cards: JournalInputCardIndex
): void {
  lineage.releaseHistory((id) => {
    const keep = currentJournalInputIdentity(state, id, () => cards.hasOverlay(id))
    if (!keep) {
      cards.releaseCard(id, state.lastSequence)
    }
    return keep
  })
  cards.releaseHistory()
}

export function queryJournalInputCurrent(
  place: JournalInputPlace,
  coordinates: JournalInputPlaceIndex
): InputPlaceQuery {
  return queryInputContext(
    place.context,
    place.original,
    (coordinate) => coordinates.query(coordinate.epoch, coordinate.sequence),
    () => coordinates.allPlaces(),
    mergeInputPlaces
  )
}

export function journalInputCardPrecedes(
  lineage: JournalInputCard | undefined,
  place: JournalInputPlace
): boolean {
  if (!lineage || lineage.introduced >= place.context.cut) {
    return false
  }
  if (place.context.basis === 'observed') {
    return true
  }
  if (!lineage.baseline) {
    return false
  }
  const coordinate = lineage.baseline.coordinate
  return queryInputContext(
    place.context,
    place.original,
    (boundary) => coordinate?.epoch === boundary.epoch && coordinate.sequence < boundary.sequence,
    () => true,
    (a, b) => a || b
  )
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
    Boolean(prior.body.command) === Boolean(card.body.command)
  )
}
