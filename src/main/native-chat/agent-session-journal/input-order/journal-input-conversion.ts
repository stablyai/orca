import { memoryJournalMap } from '../journal-memory-collections'
import { readJournalLegacyCards } from '../queued-messages/journal-queue-import'
import { isQueuedAgentJournalSubmission } from '../../../../shared/agent-session/requests/agent-session-queued-submission'
import type { JournalReducerState } from '../projection/journal-reducer'
import { initializeJournalInputOrder, journalInputOrder } from './journal-input-order'
import type { JournalOutcomeFold } from '../outcomes/journal-outcome-codec'
import type { JournalInputCard, JournalInputEntry } from './journal-input-lineage'
import type Database from '../../../sqlite/sync-database'
import { restoredJournalPersonAcceptance } from '../replay/journal-historical-inputs'
import type { JournalOutcomeSource } from '../outcomes/journal-outcome-format'

export type JournalNativePrefix = {
  entries: Map<string, JournalInputEntry>
  cards: Map<string, JournalInputCard>
  base: number
  personAcceptedSequence: number
}

/** Marker-5 ordinary keys remain frozen; native evidence is lifted only after tail overrides. */
export function detachJournalNativePrefix(state?: JournalReducerState): JournalNativePrefix {
  const prefix = {
    personAcceptedSequence: state ? journalInputOrder(state).latestPersonAcceptedSequence() : 0,
    entries: new Map(state ? memoryJournalMap(state.inputEntries) : undefined),
    cards: new Map(state ? memoryJournalMap(state.inputCards) : undefined),
    base: state ? (journalInputOrder(state).legacy?.lineage.at(0) ?? 0) : 0
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
  prefix: JournalNativePrefix,
  source: JournalOutcomeSource
): void {
  if (format < 2) {
    for (const [id, own] of prefix.entries) {
      if (
        state.submissions.get(id)?.dispatchState === 'pending' &&
        !fold.replaced('submissions', id) &&
        (own.context.source.epoch !== state.epoch ||
          own.context.source.sequence === state.submissions.get(id)?.acceptedSequence)
      ) {
        state.inputEntries.set(id, own)
      }
    }
    for (const [id, card] of prefix.cards) {
      if (!state.queue.cards.has(id) && !fold.replaced('queue.cards', id)) {
        state.inputCards.set(id, card)
      }
    }
    for (const [id, card] of memoryJournalMap(state.queue.cards)) {
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
    for (const [id, entry] of memoryJournalMap(state.submissions)) {
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
            basis: 'observed',
            cut: prefix.base + sequence
          }
        })
      }
    }
  }
  for (const [id, entry] of memoryJournalMap(state.inputEntries)) {
    if (entry.context.basis === 'legacy') {
      state.inputEntries.set(id, {
        ...entry,
        context: { ...entry.context, basis: 'observed' }
      })
    }
  }
  const owner = initializeJournalInputOrder(state)
  if (format < 3) {
    owner.beginReconstruction()
  }
  owner.seedPersonAcceptance(prefix.personAcceptedSequence)
  owner.restore(state)
  const legacyCards = readJournalLegacyCards(db, state)
  owner.overlay(state, legacyCards)
  const personal = restoredJournalPersonAcceptance(
    db,
    state,
    source,
    new Map(legacyCards.map((card) => [card.messageId, card]))
  )
  for (const card of legacyCards) {
    if (state.queue.cards.has(card.messageId)) {
      continue
    }
    const send = card.consumedAs === null ? undefined : state.submissions.get(card.consumedAs)
    if (send?.dispatchState === 'accepted' && personal(send)) {
      owner.seedPersonAcceptance(send.acceptedSequence ?? 0)
    }
  }
  owner.finishReconstruction(state)
}
