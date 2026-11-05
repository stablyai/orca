import { finishJournalSteps, finishJournalStepsAsync } from './journal-reconstruction-steps'
import type { JournalReadConnection } from './journal-sql-owner'
import { readJournalLegacyCards, readJournalLegacyCardsAsync } from './journal-queue-import'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session/requests/agent-session-queued-submission'
import type { JournalReducerState } from './journal-reducer'
import {
  initializeJournalInputOrder,
  initializeJournalInputOrderSteps,
  journalInputOrder
} from './journal-input-order'
import type { JournalOutcomeFold } from './journal-outcome-codec'
import type { JournalInputCard, JournalInputEntry } from './journal-input-lineage'
import type Database from '../../sqlite/sync-database'
import { journalInputAcceptance, prepareJournalAcceptance } from './journal-input-provenance'

export type JournalNativePrefix = {
  entries: Map<string, JournalInputEntry>
  cards: Map<string, JournalInputCard>
  base: number
}

/** Marker-5 ordinary keys remain frozen; native evidence is lifted only after tail overrides. */
export function detachJournalNativePrefix(state?: JournalReducerState): JournalNativePrefix {
  return finishJournalSteps(detachJournalNativePrefixSteps(state))
}

export function* detachJournalNativePrefixSteps(
  state?: JournalReducerState
): Generator<void, JournalNativePrefix> {
  const prefix: JournalNativePrefix = {
    entries: new Map(),
    cards: new Map(),
    base: state ? journalInputOrder(state).lineage.at(0) : 0
  }
  for (const [id, entry] of state?.inputEntries ?? []) {
    prefix.entries.set(id, entry)
    yield
  }
  for (const [id, card] of state?.inputCards ?? []) {
    prefix.cards.set(id, card)
    yield
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
  for (const _step of liftJournalNativePrefix(state, format, fold, prefix)) {
    /* synchronous native contract */
  }
  const owner = initializeJournalInputOrder(state, (id) =>
    journalInputAcceptance(db, state.sessionId, id)
  )
  owner.beginReconstruction()
  owner.restore(state)
  owner.overlay(state, readJournalLegacyCards(db, state))
  owner.finishReconstruction(state)
}

function* liftJournalNativePrefix(
  state: JournalReducerState,
  format: number,
  fold: JournalOutcomeFold,
  prefix: JournalNativePrefix
): Generator<void> {
  if (format < 2) {
    for (const [id, own] of prefix.entries) {
      yield
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
      yield
      if (!state.queue.cards.has(id) && !fold.replaced('queue.cards', id)) {
        state.inputCards.set(id, card)
      }
    }
    for (const [id, card] of state.queue.cards) {
      yield
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
      yield
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
}

export async function restoreJournalNativeStateAsync(
  read: JournalReadConnection,
  state: JournalReducerState,
  format: number,
  fold: JournalOutcomeFold,
  prefix: JournalNativePrefix
): Promise<void> {
  await finishJournalStepsAsync(liftJournalNativePrefix(state, format, fold, prefix))
  const owner = await finishJournalStepsAsync(initializeJournalInputOrderSteps(state))
  const ids = await finishJournalStepsAsync(owner.acceptanceIdsSteps())
  const acceptance = await prepareJournalAcceptance(read, state.sessionId, ids)
  const cards = await readJournalLegacyCardsAsync(read, state)
  function* reconstruct(): Generator<void> {
    yield* owner.beginReconstructionSteps()
    yield* owner.restoreSteps(state)
    for (const id of ids) {
      owner.place(id)
      yield
    }
    yield* owner.overlaySteps(state, cards)
    yield* owner.finishReconstructionSteps(state)
  }
  await finishJournalStepsAsync(reconstruct(), (next) => owner.withAcceptance(acceptance, next))
}

/** Replacement carries facts directly; restatement is not a new admission or introduction. */
export function copyJournalNativeState(
  previous: JournalReducerState,
  state: JournalReducerState
): void {
  finishJournalSteps(copyJournalNativeStateSteps(previous, state))
}

export function* copyJournalNativeStateSteps(
  previous: JournalReducerState,
  state: JournalReducerState
): Generator<void> {
  for (const [id, own] of previous.inputEntries) {
    state.inputEntries.set(id, {
      ...own,
      context: { ...own.context, source: { ...own.context.source } }
    })
    yield
  }
  for (const [id, card] of previous.inputCards) {
    state.inputCards.set(id, {
      ...card,
      ...(card.baseline
        ? { baseline: { coordinate: card.baseline.coordinate && { ...card.baseline.coordinate } } }
        : {})
    })
    yield
  }
  yield* journalInputOrder(state).lineage.restoreFrontierSteps(
    state.lastSequence,
    state.inputEntries.values()
  )
}
