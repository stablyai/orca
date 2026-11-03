import { journalInputAcceptance, prepareJournalAcceptance } from './journal-input-provenance'
import { copyJournalNativeState } from './journal-input-conversion'
import { journalInputOrder } from './journal-input-order'
import type Database from '../../sqlite/sync-database'
import { createJournalReducerState, type JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import {
  advanceJournalOutcomeSource,
  journalOutcomeSource,
  startJournalOutcomeLog
} from './journal-outcome-format'
import { persistJournalOutcomeRows, prepareJournalOutcomeRowsAsync } from './journal-outcome-table'
import type { JournalPersistencePlan } from './journal-persistence-plan'
import { retainJournalReadViews } from './journal-read-view'

export function journalOutcomeAcceptanceIds(
  state: JournalReducerState,
  rows: readonly JournalRow[]
): string[] {
  const ids = new Set<string>()
  for (const row of rows) {
    if (
      row.kind === 'submission' &&
      row.handoverRecorded &&
      row.queuedMessageId === undefined &&
      (!row.inputOrderContext || row.inputOrderContext.basis === 'legacy') &&
      !state.inputEntries.has(row.clientMessageId)
    ) {
      ids.add(row.clientMessageId)
    }
    if (row.kind === 'dispatch' && row.keptAsQueuedMessageId) {
      ids.add(row.clientMessageId)
    }
  }
  return [...ids]
}

export async function prepareJournalOutcomeWriteAsync(
  plan: JournalPersistencePlan,
  live: JournalReducerState,
  rows: readonly JournalRow[],
  savedAt: number
) {
  const previous = await plan.source(live.sessionId, live.epoch)
  if (previous && previous.through !== live.lastSequence) {
    throw new Error('journal outcome writer has stale coverage')
  }
  const acceptance = await prepareJournalAcceptance(
    plan,
    live.sessionId,
    journalOutcomeAcceptanceIds(live, rows)
  )
  const transition = await prepareJournalOutcomeRowsAsync(
    live,
    rows,
    savedAt,
    !previous || previous.format < 2,
    undefined,
    acceptance
  )
  plan.add({
    kind: 'outcomes',
    sessionId: live.sessionId,
    epoch: live.epoch,
    expected: live.lastSequence,
    savedAt,
    values: transition.values,
    through: transition.state.lastSequence
  })
  plan.preparedState = transition.state
  return {
    ...transition,
    adopt: () => {
      retainJournalReadViews(live, transition.values)
      return transition.adopt()
    }
  }
}

export async function publishJournalOutcomeEpochAsync(
  plan: JournalPersistencePlan,
  sessionId: string,
  epoch: string,
  rows: readonly JournalRow[],
  previous?: JournalReducerState
) {
  const first = rows[0]
  if (!first || first.seq !== 1 || first.kind !== 'epoch') {
    throw new Error('missing founding epoch')
  }
  const initial = createJournalReducerState(sessionId, epoch)
  if (previous) {
    copyJournalNativeState(previous, initial)
  }
  journalInputOrder(initial).beginReconstruction()
  const acceptance = await prepareJournalAcceptance(plan, sessionId, [
    ...journalOutcomeAcceptanceIds(initial, rows),
    ...journalInputOrder(initial).needsAcceptance([...initial.inputEntries.keys()])
  ])
  const transition = await prepareJournalOutcomeRowsAsync(
    initial,
    rows,
    undefined,
    true,
    (state) => {
      const order = journalInputOrder(state)
      order.restore(state)
      for (const id of order.needsAcceptance([...state.inputEntries.keys()])) {
        order.place(id)
      }
      order.finishReconstruction(state)
    },
    acceptance
  )
  plan.add({
    kind: 'outcomes',
    sessionId,
    epoch,
    expected: 0,
    savedAt: first.ts,
    values: transition.values,
    through: transition.state.lastSequence
  })
  plan.preparedState = transition.state
  return transition
}

/** Every write stores outcome records, and nothing else: they are the saved chat. An input-only epoch
 * keeps its rows as they are and starts its records here, after them. */
export function prepareJournalOutcomeWrite(
  db: Database.Database,
  live: JournalReducerState,
  rows: readonly JournalRow[],
  savedAt: number
): { state: JournalReducerState; adopt: () => JournalReducerState } {
  const previous = journalOutcomeSource(db, live.sessionId, live.epoch)
  const source =
    previous ?? startJournalOutcomeLog(db, live.sessionId, live.epoch, live.lastSequence, savedAt)
  if (source.through !== live.lastSequence) {
    throw new Error('journal outcome writer has stale coverage')
  }
  const transition = persistJournalOutcomeRows(
    db,
    live,
    source,
    rows,
    savedAt,
    !previous || previous.format < 2
  )
  advanceJournalOutcomeSource(db, live.sessionId, live.epoch, transition.state.lastSequence)
  return transition
}

/** Epoch builders use the same transition encoder; the epoch's journal rows hold only its marker. */
export function publishJournalOutcomeEpoch(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  rows: readonly JournalRow[],
  previous?: JournalReducerState
): { adopt: () => JournalReducerState } {
  const first = rows[0]
  if (!first || first.seq !== 1 || first.kind !== 'epoch') {
    throw new Error('missing founding epoch')
  }
  const source = startJournalOutcomeLog(db, sessionId, epoch, 0, first.ts)
  const initial = createJournalReducerState(sessionId, epoch, (id) =>
    journalInputAcceptance(db, sessionId, id)
  )
  if (previous) {
    copyJournalNativeState(previous, initial)
  }
  journalInputOrder(initial).beginReconstruction()
  const transition = persistJournalOutcomeRows(
    db,
    initial,
    source,
    rows,
    undefined,
    true,
    (state) => {
      journalInputOrder(state).restore(state)
      journalInputOrder(state).finishReconstruction(state)
    }
  )
  advanceJournalOutcomeSource(db, sessionId, epoch, transition.state.lastSequence)
  return { adopt: transition.adopt }
}
