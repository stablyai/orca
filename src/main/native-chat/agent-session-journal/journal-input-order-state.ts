import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalInputOrder } from './journal-input-order'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalReducerState } from './journal-reducer'
import type { JournalInputEntry } from './journal-input-lineage'
import type { JournalRow } from './journal-row-schema'

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
    const accepted = originalAcceptance?.(id)
    if (accepted) {
      originals.set(id, accepted)
    }
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

export function* restoreJournalInputPlacesSteps(
  state: JournalReducerState,
  removed?: (id: string) => void
): Generator<void, number> {
  let legacyPlaces = 0
  for (const [id, own] of state.inputEntries) {
    if (state.submissions.get(id)?.dispatchState !== 'pending') {
      state.inputEntries.delete(id)
      removed?.(id)
    } else if (own.context.basis === 'legacy') {
      legacyPlaces++
    }
    yield
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

export function journalInputsNeedingAcceptance(
  state: JournalReducerState,
  originals: ReadonlyMap<string, unknown>,
  ids: readonly string[]
): string[] {
  return ids.filter(
    (id) => state.inputEntries.get(id)?.context.basis === 'legacy' && !originals.has(id)
  )
}

export function* journalInputAcceptanceIdsSteps(
  state: JournalReducerState,
  originals: ReadonlyMap<string, unknown>
): Generator<void, string[]> {
  const ids: string[] = []
  for (const id of state.inputEntries.keys()) {
    if (journalInputsNeedingAcceptance(state, originals, [id]).length) {
      ids.push(id)
    }
    yield
  }
  return ids
}

export function prepareJournalInputRow(
  owner: Pick<JournalInputOrder, 'lineage' | 'cards' | 'place'>,
  state: JournalReducerState,
  ownState: JournalReducerState,
  row: JournalRow,
  originalAcceptance?: (id: string) => AgentJournalCursor | undefined
): boolean {
  if (row.kind === 'dispatch' && row.keptAsQueuedMessageId) {
    const place = owner.place(row.clientMessageId)
    if (place && !owner.lineage.cards.has(row.keptAsQueuedMessageId)) {
      owner.lineage.cards.set(row.keptAsQueuedMessageId, {
        introduced: place.context.cut,
        baseline: { coordinate: place.coordinate }
      })
    }
  }
  if (row.kind === 'epoch' && row.inputOrderLineage) {
    owner.lineage.load(row.inputOrderLineage)
  }
  owner.lineage.observe(row.seq)
  if (row.kind !== 'submission' || !row.handoverRecorded || row.queuedMessageId !== undefined) {
    return false
  }
  if (ownState.inputEntries.has(row.clientMessageId)) {
    return false
  }
  const place = owner.cards.admission(state, row, originalAcceptance)
  ownState.inputEntries.set(row.clientMessageId, {
    context: place.context,
    ...(place.witnessCardId ? { witnessCardId: place.witnessCardId } : {})
  })
  return place.context.basis === 'legacy'
}

export function refreshJournalInputRow(
  state: JournalReducerState,
  row: JournalRow,
  refresh: (id: string) => void
): void {
  const refreshItem = (itemId: string): void => {
    const identity = parseAgentJournalItemKey(itemId)
    if (identity?.provider === 'orca') {
      refresh(identity.clientMessageId)
    }
  }
  if (row.kind === 'submission' || row.kind === 'dispatch') {
    refresh(row.clientMessageId)
  } else if (row.kind === 'tombstone' && row.retireSubmission) {
    refreshItem(row.itemId)
  } else if (row.kind === 'item') {
    refreshItem(state.aliases.get(row.itemId) ?? row.itemId)
  } else if (row.kind === 'lifecycle-batch') {
    for (const mutation of row.mutations) {
      refreshItem(state.aliases.get(mutation.itemId) ?? mutation.itemId)
    }
  } else if (row.kind === 'queue') {
    const id = state.queue.cards.get(row.messageId)?.consumedAs
    if (id) {
      refresh(id)
    }
  }
}
