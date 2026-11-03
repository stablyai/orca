import { startJournalRowFold, type JournalLoad } from './journal-open'
import type { JournalReadConnection } from './journal-sql-owner'
import { journalOutcomeAcceptanceIds } from './journal-outcome-write'
import { readJournalLegacyCardsAsync } from './journal-queue-import'
import { journalInputOrder } from './journal-input-order'
// Replay live epochs without rewriting history; damage/newer rows fail load and remain on disk.

import { readJournalOutcomesAsync } from './journal-outcome-table'
import { JournalOutcomeDecodeError } from './journal-outcome-codec'
import {
  readJournalOutcomeGroupsAsync,
  type JournalReadRow,
  type JournalRowsRead
} from './journal-read-row'
import { AgentSessionJournalError } from './journal-write-guards'

import { prepareJournalAcceptance } from './journal-input-provenance'
import { createJournalReducerState, type JournalReducerState } from './journal-reducer'
import { iterateJournalEpochRowsAsync } from './journal-row-table'
import { parseJournalRow } from './journal-row-schema'
import { finishJournalStepsAsync } from './journal-reconstruction-steps'

export async function restoreJournalAsync(
  read: JournalReadConnection,
  sessionId: string
): Promise<JournalLoad | null> {
  const epoch = (
    await read.prepare('SELECT epoch FROM journal_sessions WHERE session_id = ?').get(sessionId)
  )?.epoch
  if (typeof epoch !== 'string') {
    return null
  }
  const empty = createJournalReducerState(sessionId, epoch)
  try {
    const source = await read.source(sessionId, epoch)
    if (!source) {
      return foldJournalFromStateAsync(read, empty)
    }
    let baseline: JournalReducerState | undefined
    if (source.prefix > 0) {
      const prefix = await foldJournalFromStateAsync(read, empty, source.prefix, true)
      if (prefix.newer || prefix.damage || prefix.state.lastSequence !== source.prefix) {
        const gap = { sequence: prefix.state.lastSequence + 1, cause: 'sequence-gap' as const }
        return { ...prefix, damage: prefix.newer ? null : (prefix.damage ?? gap) }
      }
      baseline = prefix.state
    }
    const state = await readJournalOutcomesAsync(read, sessionId, epoch, source, baseline)
    return { state, newer: null, damage: null }
  } catch (error) {
    if (error instanceof AgentSessionJournalError && error.code === 'journal_read_only') {
      return { state: empty, newer: { sequence: 1 }, damage: null }
    }
    if (error instanceof JournalOutcomeDecodeError) {
      return { state: empty, newer: null, damage: { sequence: 1, cause: 'unparseable-row' } }
    }
    throw error
  }
}

async function foldJournalFromStateAsync(
  read: JournalReadConnection,
  state: JournalReducerState,
  through = Number.MAX_SAFE_INTEGER,
  deferNativeCleanup = false
): Promise<JournalLoad> {
  const fold = startJournalRowFold(
    { sessionId: state.sessionId, epoch: state.epoch, deferNativeCleanup: true },
    state
  )
  const owner = journalInputOrder(state)
  const pages = iterateJournalEpochRowsAsync(
    read,
    state.sessionId,
    state.epoch,
    state.lastSequence === 0 ? Number.MIN_SAFE_INTEGER : state.lastSequence,
    through
  )
  for await (const page of pages) {
    const parsed = page.map((entry) => parseJournalRow(entry.rowJson))
    const rows = parsed.flatMap((row) => (row.ok ? [row.row] : []))
    const acceptance = await prepareJournalAcceptance(
      read,
      state.sessionId,
      journalOutcomeAcceptanceIds(state, rows)
    )
    let more = true
    for (const [index, entry] of page.entries()) {
      const row = parsed[index]
      if (row.ok) {
        await finishJournalStepsAsync(owner.prepareRowSteps(state, row.row))
      }
      if (
        !(await finishJournalStepsAsync(fold.addSteps(entry, row), (next) =>
          owner.withAcceptance(acceptance, next)
        ))
      ) {
        more = false
        break
      }
    }
    if (!more) {
      break
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  if (!deferNativeCleanup) {
    const ids = await finishJournalStepsAsync(owner.acceptanceIdsSteps())
    const acceptance = await prepareJournalAcceptance(read, state.sessionId, ids)
    const cards = await readJournalLegacyCardsAsync(read, state)
    function* finish(): Generator<void> {
      for (const id of ids) {
        owner.place(id)
        yield
      }
      yield* owner.overlaySteps(state, cards)
      yield* owner.finishReconstructionSteps(state)
      yield* owner.lineage.restoreFrontierSteps(state.lastSequence, state.inputEntries.values())
    }
    await finishJournalStepsAsync(finish(), (next) => owner.withAcceptance(acceptance, next))
  }
  return fold.finish()
}

export async function readJournalRowsAfterCursorAsync(
  read: JournalReadConnection,
  sessionId: string,
  epoch: string,
  afterSequence: number,
  limit?: number
): Promise<JournalRowsRead> {
  const source = await read.source(sessionId, epoch)
  const prefix = source?.prefix ?? Number.MAX_SAFE_INTEGER
  const rows: JournalReadRow[] = []
  const stopped = (): JournalRowsRead => ({ rows, through: rows.at(-1)?.seq ?? afterSequence })
  if (afterSequence < prefix) {
    for await (const page of iterateJournalEpochRowsAsync(
      read,
      sessionId,
      epoch,
      afterSequence,
      prefix,
      limit
    )) {
      for (const stored of page) {
        const parsed = parseJournalRow(stored.rowJson)
        if (!parsed.ok) {
          return stopped()
        }
        rows.push(parsed.row)
      }
    }
    if (!source || (limit !== undefined && rows.length >= limit)) {
      return stopped()
    }
  }
  if (!source) {
    return stopped()
  }
  const remaining = limit === undefined ? undefined : limit - rows.length
  const groups = await readJournalOutcomeGroupsAsync(
    read,
    epoch,
    source,
    Math.max(afterSequence, prefix),
    remaining
  )
  for (const group of groups) {
    rows.push(group)
  }
  return remaining === undefined || groups.length < remaining
    ? { rows, through: source.through }
    : stopped()
}
