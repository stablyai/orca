import type { JournalReadConnection } from './journal-sql-owner'
import { journalInputOrder } from './journal-input-order'
import {
  detachJournalNativePrefix,
  restoreJournalNativeState,
  restoreJournalNativeStateAsync
} from './journal-input-conversion'
import type Database from '../../sqlite/sync-database'
import type { JournalReducerState } from './journal-reducer'
import { applyJournalRow } from './journal-reducer'
import { isolateJournalTransition } from './journal-reducer-transition'
import type { JournalRow } from './journal-row-schema'
import { journalRowReadBack } from './journal-row-table'
import {
  encodeJournalOutcomes,
  journalOutcomeScalars,
  JournalOutcomeFold
} from './journal-outcome-codec'
import type { JournalOutcomeSource } from './journal-outcome-format'
import type { JournalEncodedOutcome } from './journal-persistence-plan'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  JOURNAL_NEWEST_OUTCOME_SQL,
  writeJournalEncodedOutcomes
} from './journal-outcome-persistence'
export { JOURNAL_NEWEST_OUTCOME_SQL } from './journal-outcome-persistence'

/** Folds each key's newest record, deletions included, over `baseline`, the chat's folded input
 * prefix when it has one. Superseded revisions are never read: they no longer shape the chat. */
export function readJournalOutcomes(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  source: JournalOutcomeSource,
  baseline?: JournalReducerState
): JournalReducerState {
  const newest = db.prepare(JOURNAL_NEWEST_OUTCOME_SQL)
  const prefix = detachJournalNativePrefix(baseline)
  const fold = new JournalOutcomeFold()
  let after = { field: '', key: '' }
  for (;;) {
    const row = newest.get(source.generation, after.field, after.key, source.through)
    if (!row) {
      const state = fold.finish(sessionId, epoch, source.through, baseline)
      restoreJournalNativeState(db, state, source.format, fold, prefix)
      return state
    }
    const value = fold.add(row)
    after = { field: value.field, key: value.key }
  }
}

/** Uses the same private canonical fold for native persistence and host preparation. */
function* prepareJournalOutcomeSteps(
  state: JournalReducerState,
  rows: readonly JournalRow[],
  savedAt?: number,
  upgradeNative = false,
  finish?: (state: JournalReducerState) => void,
  acceptance?: (id: string) => AgentJournalCursor | undefined
): Generator<
  void,
  { state: JournalReducerState; adopt: () => JournalReducerState; values: JournalEncodedOutcome[] }
> {
  const values: JournalEncodedOutcome[] = []
  let scalar = state.lastSequence === 0 ? {} : journalOutcomeScalars(state)
  const transition = isolateJournalTransition(state, () => undefined)
  journalInputOrder(transition.state).introduceOverlays(transition.state)
  let examined = 0,
    bytes = 0
  for (const row of rows) {
    // Folding what a reload reads keeps live state equal to it: an annotation the reader drops as
    // unusable never reaches the model, so it is never refused by the strict record encoder.
    const { stored } = journalRowReadBack(state.sessionId, row)
    const apply = () => {
      applyJournalRow(transition.state, stored, savedAt ?? row.ts)
      if (row === rows.at(-1)) {
        finish?.(transition.state)
      }
    }
    if (acceptance) {
      journalInputOrder(transition.state).withAcceptance(acceptance, apply)
    } else {
      apply()
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
    // Only this row's own transition is recorded, never a snapshot of a prefix value it left alone.
    const encoded = encodeJournalOutcomes(transition.state, changes, scalar, transition.untracked)
    scalar = encoded.scalars
    for (const [index, value] of encoded.values.entries()) {
      // Each change's record is at its own index; the scalar records after them match no change.
      const change = changes.at(index)
      bytes += Buffer.byteLength(value.json)
      values.push({
        ...value,
        index,
        reinsert: Boolean(change?.reinsert),
        changed: Boolean(change)
      })
    }
    if (++examined >= 128 || bytes >= 256 * 1024) {
      examined = bytes = 0
      yield
    }
  }
  return { state: transition.state, adopt: transition.adopt, values }
}

export function prepareJournalOutcomeRows(...input: Parameters<typeof prepareJournalOutcomeSteps>) {
  const steps = prepareJournalOutcomeSteps(...input)
  for (;;) {
    const next = steps.next()
    if (next.done) {
      return next.value
    }
  }
}
export async function prepareJournalOutcomeRowsAsync(
  ...input: Parameters<typeof prepareJournalOutcomeSteps>
) {
  const steps = prepareJournalOutcomeSteps(...input)
  for (;;) {
    const next = steps.next()
    if (next.done) {
      return next.value
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

/** Direct native contracts use the same encoder and SQL ordinal decisions. */
export function persistJournalOutcomeRows(
  db: Database.Database,
  state: JournalReducerState,
  source: Pick<JournalOutcomeSource, 'generation' | 'prefix'>,
  rows: readonly JournalRow[],
  savedAt?: number,
  upgradeNative = false,
  finish?: (state: JournalReducerState) => void
) {
  const transition = prepareJournalOutcomeRows(state, rows, savedAt, upgradeNative, finish)
  writeJournalEncodedOutcomes(db, source, transition.values)
  return transition
}

/** A finite snapshot supplies bounded newest-key pages without one host round trip per key. */
export async function readJournalOutcomesAsync(
  read: JournalReadConnection,
  sessionId: string,
  epoch: string,
  source: JournalOutcomeSource,
  baseline?: JournalReducerState
): Promise<JournalReducerState> {
  const prefix = detachJournalNativePrefix(baseline)
  const fold = new JournalOutcomeFold()
  let after = { field: '', key: '' }
  for (;;) {
    const rows = await read.outcomes(source.generation, source.through, after.field, after.key)
    if (!rows.length) {
      const state = fold.finish(sessionId, epoch, source.through, baseline)
      await restoreJournalNativeStateAsync(read, state, source.format, fold, prefix)
      return state
    }
    for (const row of rows) {
      const value = fold.add(row)
      after = { field: value.field, key: value.key }
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}
