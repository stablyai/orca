import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { JournalReducerState } from './journal-reducer'
import type { JournalInputEntry } from './journal-input-lineage'
import { JournalInputOrder } from './journal-input-order'

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

const owners = new WeakMap<JournalReducerState, JournalInputOrder>()
export function initializeJournalInputOrder(
  state: JournalReducerState,
  originalAcceptance?: (id: string) => AgentJournalCursor | undefined
): JournalInputOrder {
  const owner = new JournalInputOrder(state, originalAcceptance)
  owners.set(state, owner)
  return owner
}
export function journalInputOrder(state: JournalReducerState): JournalInputOrder {
  return owners.get(state) ?? initializeJournalInputOrder(state)
}
export function setJournalInputOrder(state: JournalReducerState, owner: JournalInputOrder): void {
  owners.set(state, owner)
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
