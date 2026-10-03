// One append's undo of the fold. An append folds its row inside its transaction, so the status
// written with it describes it; if the transaction fails, what the row touched is put back.
// Entries are replaced on change, never edited, so an entry a reader holds is never one the failed
// row changed. A replaced or added key goes back in place; a removed one cannot, since re-adding it
// puts it last and key order is part of the fold (eviction is oldest-first, ties go to map order),
// so a unit that removed an entry declines the undo and its caller re-reads the fold instead.

import type { JournalReducerState } from './journal-reducer'

type Undo = () => void
/** Null for a change no undo can put back in place: the removal of an entry. */
type Recorder = (undo: Undo | null) => void

/** A fold container that, while a unit is open, tells it each change it is about to make. */
export class JournalFoldMap<K, V> extends Map<K, V> {
  onChange: Recorder | null = null

  override set(key: K, value: V): this {
    this.record(key)
    return super.set(key, value)
  }

  override delete(key: K): boolean {
    if (this.onChange && super.has(key)) {
      this.onChange(null)
    }
    return super.delete(key)
  }

  private record(key: K): void {
    if (!this.onChange) {
      return
    }
    if (super.has(key)) {
      const previous = super.get(key)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `has` just answered true, so `get` returned the key's own value, `undefined` included when V allows it.
      this.onChange(() => super.set(key, previous as V))
    } else {
      this.onChange(() => super.delete(key))
    }
  }
}

export class JournalFoldSet<T> extends Set<T> {
  onChange: Recorder | null = null

  override add(value: T): this {
    if (this.onChange && !super.has(value)) {
      this.onChange(() => super.delete(value))
    }
    return super.add(value)
  }

  override delete(value: T): boolean {
    if (this.onChange && super.has(value)) {
      this.onChange(null)
    }
    return super.delete(value)
  }
}

export type JournalFoldUndo = {
  /** COMMIT landed: the fold as it stands is adopted. */
  commit: () => void
  /** The transaction failed: every change since the unit began is put back, newest first. False,
   *  changing nothing, when the unit removed an entry; the caller then re-reads the fold. */
  rollback: () => boolean
}

/** Null when the fold's containers cannot record their changes; the caller re-reads it instead. */
export function beginJournalFoldUndo(state: JournalReducerState): JournalFoldUndo | null {
  const containers: readonly object[] = [
    state.items,
    state.itemFences,
    state.tombstones,
    state.submissions,
    state.receipts,
    state.aliases,
    state.appliedSettlementIds
  ]
  const recording: { onChange: Recorder | null }[] = []
  for (const container of containers) {
    if (!(container instanceof JournalFoldMap || container instanceof JournalFoldSet)) {
      return null
    }
    recording.push(container)
  }
  const undos: Undo[] = []
  let restorable = true
  const record: Recorder = (undo) => {
    if (undo) {
      undos.push(undo)
    } else {
      restorable = false
    }
  }
  const scalars = {
    epoch: state.epoch,
    lastSequence: state.lastSequence,
    lastActivityAt: state.lastActivityAt,
    oldestSequence: state.oldestSequence,
    highestFence: state.highestFence,
    latestPersonTurnSequence: state.latestPersonTurnSequence
  }
  const derivedTurnScope = state.derivedTurnScope.clone()
  // Edited in place by the fold; its fields are replaced, never mutated, so a shallow copy restores it.
  const queuePauseMarks = { ...state.queuePauseMarks }
  for (const container of recording) {
    container.onChange = record
  }
  const detach = () => {
    for (const container of recording) {
      container.onChange = null
    }
  }
  return {
    commit: detach,
    rollback: () => {
      detach()
      if (!restorable) {
        return false
      }
      for (const undo of undos.toReversed()) {
        undo()
      }
      Object.assign(state, scalars)
      state.derivedTurnScope = derivedTurnScope
      Object.assign(state.queuePauseMarks, queuePauseMarks)
      return true
    }
  }
}
