import { retainJournalReadViews } from './journal-read-view'
import type { JournalPersistencePlan } from './journal-persistence-plan'
import { prepareJournalAcceptance } from './journal-input-provenance'
import { journalInputAcceptance } from './journal-input-provenance'
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
import { persistJournalOutcomeRows } from './journal-outcome-table'
import { planJournalOutcomeRows } from './journal-outcome-plan'
import { applyJournalOutcomeAppend, type JournalOutcomeAppend } from './journal-outcome-append'
export { applyJournalOutcomeAppend, type JournalOutcomeAppend } from './journal-outcome-append'

/** Every write stores outcome records, and nothing else: they are the saved chat. An input-only epoch
 * keeps its rows as they are and starts its records here, after them. */
export function prepareJournalOutcomeWrite(
  db: Database.Database,
  live: JournalReducerState,
  rows: readonly JournalRow[],
  savedAt: number
): { state: JournalReducerState; adopt: () => JournalReducerState } {
  const prepared = prepareJournalOutcomeAppend(db, live, rows, savedAt)
  applyJournalOutcomeAppend(db, prepared.append)
  return prepared
}

/** Reads source identity on the coordinated lane; the worker rechecks it in the write transaction. */
export function prepareJournalOutcomeAppend(
  db: Database.Database,
  live: JournalReducerState,
  rows: readonly JournalRow[],
  savedAt: number
): { append: JournalOutcomeAppend; state: JournalReducerState; adopt: () => JournalReducerState } {
  const previous = journalOutcomeSource(db, live.sessionId, live.epoch)
  if (previous && previous.through !== live.lastSequence) {
    throw new Error('journal outcome writer has stale coverage')
  }
  const transition = planJournalOutcomeRows(live, rows, savedAt, !previous || previous.format < 2)
  return {
    ...transition,
    append: {
      sessionId: live.sessionId,
      epoch: live.epoch,
      previous,
      expectedSequence: live.lastSequence,
      through: transition.state.lastSequence,
      savedAt,
      values: transition.values
    }
  }
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

export function journalOutcomeAcceptanceIds(rows: readonly JournalRow[]): string[] {
  return rows.flatMap((row) =>
    row.kind === 'submission' || row.kind === 'dispatch' ? [row.clientMessageId] : []
  )
}

export async function prepareJournalOutcomePlan(
  plan: JournalPersistencePlan,
  live: JournalReducerState,
  rows: readonly JournalRow[],
  savedAt: number
): Promise<{ state: JournalReducerState; adopt: () => JournalReducerState }> {
  const previous = await plan.source(live.sessionId, live.epoch)
  if (previous && previous.through !== live.lastSequence) {
    throw new Error('journal outcome writer has stale coverage')
  }
  const acceptance = await prepareJournalAcceptance(
    plan,
    live.sessionId,
    journalOutcomeAcceptanceIds(rows)
  )
  const transition = planJournalOutcomeRows(
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
    previous,
    savedAt,
    values: transition.values,
    through: transition.state.lastSequence
  })
  plan.preparedState = transition.state
  return {
    state: transition.state,
    adopt: () => {
      retainJournalReadViews(live, transition.values)
      return transition.adopt()
    }
  }
}

export async function publishJournalOutcomeEpochPlan(
  plan: JournalPersistencePlan,
  sessionId: string,
  epoch: string,
  rows: readonly JournalRow[],
  previous?: JournalReducerState
): Promise<{ adopt: () => JournalReducerState }> {
  const first = rows[0]
  if (!first || first.seq !== 1 || first.kind !== 'epoch') {
    throw new Error('missing founding epoch')
  }
  const acceptance = await prepareJournalAcceptance(plan, sessionId, [
    ...(previous?.inputEntries.keys() ?? []),
    ...journalOutcomeAcceptanceIds(rows)
  ])
  const initial = createJournalReducerState(sessionId, epoch, acceptance)
  if (previous) {
    copyJournalNativeState(previous, initial)
  }
  journalInputOrder(initial).beginReconstruction()
  const transition = planJournalOutcomeRows(
    initial,
    rows,
    undefined,
    true,
    (state) => {
      journalInputOrder(state).restore(state)
      journalInputOrder(state).finishReconstruction(state)
    },
    acceptance
  )
  plan.add({
    kind: 'outcomes',
    sessionId,
    epoch,
    expected: 0,
    previous: null,
    savedAt: first.ts,
    values: transition.values,
    through: transition.state.lastSequence
  })
  plan.preparedState = transition.state
  return transition
}
