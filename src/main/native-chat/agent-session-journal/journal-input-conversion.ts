import { readJournalLegacyCards } from './journal-queue-import'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { JournalReducerState } from './journal-reducer'
import { initializeJournalInputOrder, journalInputOrder } from './journal-input-order'
import type { JournalOutcomeFold } from './journal-outcome-codec'
import type { JournalInputCard, JournalInputEntry } from './journal-input-lineage'
import type Database from '../../sqlite/sync-database'
import { journalInputAcceptance } from './journal-input-provenance'

export type JournalNativePrefix = {
  entries: Map<string, JournalInputEntry>
  cards: Map<string, JournalInputCard>
  base: number
}

/** Marker-5 ordinary keys remain frozen; native evidence is lifted only after tail overrides. */
export function detachJournalNativePrefix(state?: JournalReducerState): JournalNativePrefix {
  const prefix = {
    entries: new Map(state?.inputEntries),
    cards: new Map(state?.inputCards),
    base: state ? journalInputOrder(state).lineage.at(0) : 0
  }
  state?.inputEntries.clear()
  state?.inputCards.clear()
  return prefix
}

export function restoreJournalNativeState(
  db: Database.Database,
  state: JournalReducerState,
  format: number,
  fold: JournalOutcomeFold,
  prefix: JournalNativePrefix
): void {
  if (format < 2) {
    for (const [id, own] of prefix.entries) {
      if (
        state.submissions.get(id)?.dispatchState === 'pending' &&
        !fold.replaced('submissions', id)
      ) {
        state.inputEntries.set(id, own)
      }
    }
    for (const [id, card] of prefix.cards) {
      if (!state.queue.cards.has(id) && !fold.replaced('queue.cards', id)) {
        state.inputCards.set(id, card)
      }
    }
    for (const [id, card] of state.queue.cards) {
      const known = !fold.replaced('queue.cards', id) ? prefix.cards.get(id) : undefined
      const introducedAt = fold.introduction('queue.cards', id)
      if (known) {
        state.inputCards.set(id, known)
      } else if (introducedAt !== undefined) {
        state.inputCards.set(id, {
          introduced: prefix.base + introducedAt,
          baseline: { coordinate: card.queuedAt }
        })
      }
    }
    for (const [id, entry] of state.submissions) {
      const sequence = entry.acceptedSequence ?? entry.submittedSequence
      if (
        !state.inputEntries.has(id) &&
        isQueuedAgentJournalSubmission(entry) &&
        !entry.queuedMessageId &&
        sequence !== undefined
      ) {
        state.inputEntries.set(id, {
          context: {
            source: { epoch: state.epoch, sequence },
            basis: 'legacy',
            cut: prefix.base + sequence
          }
        })
      }
    }
  }
  const owner = initializeJournalInputOrder(state, (id) =>
    journalInputAcceptance(db, state.sessionId, id)
  )
  owner.beginReconstruction()
  owner.restore(state)
  owner.overlay(state, readJournalLegacyCards(db, state))
  owner.finishReconstruction(state)
}

/** Replacement carries facts directly; restatement is not a new admission or introduction. */
export function copyJournalNativeState(
  previous: JournalReducerState,
  state: JournalReducerState
): void {
  for (const [id, own] of previous.inputEntries) {
    state.inputEntries.set(id, {
      ...own,
      context: { ...own.context, source: { ...own.context.source } }
    })
  }
  for (const [id, card] of previous.inputCards) {
    state.inputCards.set(id, {
      ...card,
      ...(card.baseline
        ? { baseline: { coordinate: card.baseline.coordinate && { ...card.baseline.coordinate } } }
        : {})
    })
  }
  journalInputOrder(state).lineage.restoreFrontier(state.lastSequence, state.inputEntries.values())
}
