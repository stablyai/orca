import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { restoreRetainedJournalInputsAsync } from './journal-retained-inputs'
import { startJournalRowFold, type JournalLoad } from './journal-open'
import type { JournalReadConnection } from './journal-sql-owner'
import { readJournalLegacyCardsAsync } from './journal-queue-import'
import { journalInputOrder } from './journal-input-order'
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
      return await foldJournalFromStateAsync(read, empty)
    }
    let baseline: JournalReducerState | undefined
    if (source.prefix > 0) {
      const prefix = await foldJournalFromStateAsync(
        read,
        empty,
        source.prefix,
        source.marker === 5 ? 'marker5' : 'sources',
        true
      )
      if (prefix.newer || prefix.damage || prefix.state.lastSequence !== source.prefix) {
        const gap = { sequence: prefix.state.lastSequence + 1, cause: 'sequence-gap' as const }
        return { ...prefix, damage: prefix.newer ? null : (prefix.damage ?? gap) }
      }
      baseline = prefix.state
    }
    const prefixRevisions =
      baseline &&
      new Map(
        [...baseline.submissions.keys()].map((id) => {
          const key = agentJournalSubmissionKey(id)
          return [
            key,
            baseline.items.get(key)?.revision ?? baseline.tombstones.get(key) ?? 0
          ] as const
        })
      )
    const state = await readJournalOutcomesAsync(read, sessionId, epoch, source, baseline)
    if (source.marker === 5 && source.prefix > 0) {
      const observations = await foldJournalFromStateAsync(
        read,
        createJournalReducerState(sessionId, epoch),
        source.prefix,
        'sources'
      )
      if (observations.newer || observations.damage) {
        return observations
      }
      state.inputs = observations.state.inputs
      state.inputs.candidates.clear()
    }
    await restoreRetainedJournalInputsAsync(read, state, source, prefixRevisions)
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
  interpretation: 'marker5' | 'sources' = 'sources',
  deferNativeCleanup = false
): Promise<JournalLoad> {
  let acceptance = await prepareJournalAcceptance(read, state.sessionId, [])
  const ownerState = createJournalReducerState(state.sessionId, state.epoch, (id) => acceptance(id))
  const fold = startJournalRowFold(
    { sessionId: state.sessionId, epoch: state.epoch, interpretation, deferNativeCleanup },
    ownerState
  )
  const pages = iterateJournalEpochRowsAsync(
    read,
    state.sessionId,
    state.epoch,
    Number.MIN_SAFE_INTEGER,
    through
  )
  for await (const page of pages) {
    const admitted = page.map((entry) => ({
      entry,
      parsed: parseJournalRow(entry.rowJson, interpretation === 'sources')
    }))
    const ids = admitted.flatMap(({ parsed }) => {
      return parsed.ok && (parsed.row.kind === 'submission' || parsed.row.kind === 'dispatch')
        ? [parsed.row.clientMessageId]
        : []
    })
    acceptance = await prepareJournalAcceptance(read, state.sessionId, ids)
    let more = true
    for (const { entry, parsed } of admitted) {
      if (!fold.add(entry, parsed)) {
        more = false
        break
      }
    }
    if (!more) {
      break
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  acceptance = await prepareJournalAcceptance(read, state.sessionId, [
    ...ownerState.inputEntries.keys()
  ])
  if (!deferNativeCleanup) {
    journalInputOrder(ownerState).overlay(
      ownerState,
      await readJournalLegacyCardsAsync(read, ownerState)
    )
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
        const parsed = parseJournalRow(stored.rowJson, source?.marker !== 5)
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
