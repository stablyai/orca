import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { journalInputOrder } from './journal-input-order'
import type { JournalReducerState } from './journal-reducer'
import { applyJournalRow } from './journal-reducer'
import { isolateJournalTransition } from './journal-reducer-transition'
import type { JournalRow } from './journal-row-schema'
import { journalRowReadBack } from './journal-row-table'
import { encodeJournalOutcomes, journalOutcomeScalars } from './journal-outcome-codec'

import type { JournalEncodedOutcome } from './journal-persistence-plan'

export type PlannedJournalOutcome = JournalEncodedOutcome

/** Materialize the bounded changed records on main; only values cross the storage-worker boundary. */
export function planJournalOutcomeRows(
  state: JournalReducerState,
  rows: readonly JournalRow[],
  savedAt?: number,
  upgradeNative = false,
  finish?: (state: JournalReducerState) => void,
  acceptance?: (id: string) => AgentJournalCursor | undefined
): {
  values: PlannedJournalOutcome[]
  state: JournalReducerState
  adopt: () => JournalReducerState
} {
  let scalar = state.lastSequence === 0 ? {} : journalOutcomeScalars(state)
  const transition = isolateJournalTransition(state, () => undefined)
  journalInputOrder(transition.state).introduceOverlays(transition.state)
  const values: PlannedJournalOutcome[] = []
  const fold = () => {
    for (const row of rows) {
      const { stored } = journalRowReadBack(state.sessionId, row)
      applyJournalRow(transition.state, stored, savedAt ?? row.ts)
      if (row === rows.at(-1)) {
        finish?.(transition.state)
      }
      const changes = transition.changes(true)
      if (upgradeNative) {
        for (const path of ['inputEntries', 'inputCards'] as const) {
          const changed = new Set(
            changes.filter((change) => change.path === path).map((change) => change.key)
          )
          for (const [key, value] of transition.state[path]) {
            if (!changed.has(key)) {
              changes.push({ path, key, value, deleted: false, reinsert: true })
            }
          }
        }
        upgradeNative = false
      }
      const encoded = encodeJournalOutcomes(transition.state, changes, scalar, transition.untracked)
      scalar = encoded.scalars
      for (const [index, value] of encoded.values.entries()) {
        const change = changes.at(index)
        values.push({
          ...value,
          reinsert: change?.reinsert === true,
          changed: change !== undefined,
          index
        })
      }
    }
  }
  if (acceptance) {
    journalInputOrder(transition.state).withAcceptance(acceptance, fold)
  } else {
    fold()
  }
  return { values, state: transition.state, adopt: transition.adopt }
}
