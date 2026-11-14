import type Database from '../../../sqlite/sync-database'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalReducerState } from '../projection/journal-reducer'
import { outcomeFormat3PauseMarks } from '../outcomes/journal-outcome-format-3'
import { outcomeFormat1StoredScalars } from '../outcomes/journal-outcome-format-1'
import type { JournalStopEvent } from '../durable-rows/journal-row-schema'
import { parseJournalRow } from '../durable-rows/journal-row-schema'
import type { JournalOutcomeSource } from '../outcomes/journal-outcome-format'
import { decodeJournalOutcome } from '../outcomes/journal-outcome-codec'
import { journalContextEpoch } from './journal-context-epoch'
import { journalHistoryAccess } from '../database/journal-history-access'
import { historySourceState } from '../database/journal-history-source'
import {
  observedHistoryCovered,
  observedHistoryIncarnation,
  type JournalHistoryObservation
} from '../database/journal-history-observation'
import {
  emptyJournalPersonalStops,
  rememberJournalPersonalStop,
  journalPersonalStopAfter,
  type JournalPersonalStopEvidence,
  type JournalPersonalStopFrontier
} from './journal-personal-stop-frontier'

// Unknown/malformed possible Stops remain in the discovery set and fail strict decoding.
const RAW_STOPS = `(NOT json_valid(row_json) OR CASE WHEN json_valid(row_json)
  THEN json_type(row_json, '$.stopEvent') IS NOT NULL
    AND COALESCE(json_extract(row_json, '$.stopEvent.reason'), '') NOT IN ('host-stop', 'evict', 'context-clear') END)`
const CONTEXT_ROWS = `(NOT json_valid(row_json) OR CASE WHEN json_valid(row_json) THEN json_extract(row_json, '$.kind') END = 'epoch')`

function hydrateOutcomeStops(
  db: Database.Database,
  source: JournalOutcomeSource | null,
  frontier: JournalPersonalStopFrontier,
  after = frontier.boundary - 1
): void {
  if (!source) {
    return
  }
  let failure: unknown
  for (const row of db
    .prepare(`SELECT seq, field, entry_key, format, ordinal, value_json, deleted
    FROM journal_outcomes WHERE generation = ? AND seq > ? AND seq <= ?
      AND field = '$' AND entry_key = '"queuePauseMarks"' AND deleted = 0`)
    .iterate(source.generation, after, source.through)) {
    try {
      const value = decodeJournalOutcome(row)
      const marks = outcomeFormat3PauseMarks.parse(JSON.parse(value.json))
      if (marks.latestStop) {
        rememberJournalPersonalStop(frontier, marks.latestStop.sequence, marks.latestStop.event)
      }
    } catch (error) {
      failure ??= error
    }
  }
  if (failure) {
    throw failure
  }
}

/** Raw Stops come from the admitted restore pass; only missing keyed outcomes need discovery. */
export function hydrateJournalPersonalStops(
  db: Database.Database,
  state: JournalReducerState,
  source: JournalOutcomeSource | null,
  raw: readonly { sequence: number; event: JournalStopEvent }[],
  identity: string | null
): void {
  const frontier = emptyJournalPersonalStops(state.contextBoundary)
  frontier.sourceIdentity = identity
  for (const stop of raw) {
    rememberJournalPersonalStop(frontier, stop.sequence, stop.event)
  }
  try {
    hydrateOutcomeStops(db, source, frontier)
  } catch {
    // Historical evidence must not make an otherwise readable conversation unopenable.
    frontier.complete = false
  }
  if (identity === null || identity !== journalHistoryAccess(db)?.sourceIdentity(state.sessionId)) {
    frontier.complete = false
  }
  state.personalStops = frontier
}

/** Explicit recovery/answer boundaries refresh corrections; status reads stay memory-only. */
export function refreshJournalPersonalStops(
  db: Database.Database,
  state: JournalReducerState
): void {
  const identity = journalHistoryAccess(db)?.sourceIdentity(state.sessionId)
  if (identity && state.personalStops.complete && state.personalStops.sourceIdentity === identity) {
    return
  }
  const saved = readJournalPersonalStopFrontier(db, state.sessionId, true)
  if (!saved || saved.context !== journalContextEpoch(state.epoch, state.contextBoundary)) {
    throw new Error('chat retirement context changed')
  }
  state.personalStops = saved.frontier
}

export function loadedJournalPersonalStopEvidenceAfter(
  db: Database.Database,
  state: JournalReducerState,
  after: Parameters<typeof journalPersonalStopEvidenceAfter>[2]
): JournalPersonalStopEvidence {
  try {
    refreshJournalPersonalStops(db, state)
    return memoryJournalPersonalStopEvidenceAfter(state, after)
  } catch {
    return 'unknown'
  }
}

export function memoryJournalPersonalStopEvidenceAfter(
  state: JournalReducerState,
  after: Parameters<typeof journalPersonalStopEvidenceAfter>[2]
): JournalPersonalStopEvidence {
  if (
    after.cursor &&
    after.cursor.epoch !== journalContextEpoch(state.epoch, state.contextBoundary)
  ) {
    return 'unknown'
  }
  return journalPersonalStopAfter(state.personalStops, {
    sequence: after.cursor?.sequence,
    at: after.at,
    turnId: after.turnId
  })
}

/** Passive recovery checks refresh durable coverage; loaded status never calls this reader. */
export function journalPersonalStopEvidenceAfter(
  db: Database.Database,
  sessionId: string,
  after: { cursor?: AgentJournalCursor; at: number; turnId?: string }
): JournalPersonalStopEvidence {
  try {
    const saved = readJournalPersonalStopFrontier(db, sessionId)
    if (!saved) {
      return 'clear'
    }
    if (after.cursor && after.cursor.epoch !== saved.context) {
      return 'unknown'
    }
    return journalPersonalStopAfter(saved.frontier, {
      sequence: after.cursor?.sequence,
      at: after.at,
      turnId: after.turnId
    })
  } catch {
    // An unreadable chat holds only its own offer and is re-read on the next action.
    return 'unknown'
  }
}

export function readJournalPersonalStopFrontier(
  db: Database.Database,
  sessionId: string,
  refresh = false
): { context: string; frontier: JournalPersonalStopFrontier } | null {
  const access = journalHistoryAccess(db)
  let observed: JournalHistoryObservation | undefined
  try {
    observed = access?.observe(sessionId, refresh)
  } catch (error) {
    if (!refresh) {
      throw error
    }
  }
  const current = observed ?? historySourceState(db, sessionId)
  const epoch = current.epoch
  if (!epoch) {
    return null
  }
  const source = current.outcome
  const rawThrough = current.rawThrough
  const tip = source?.through ?? rawThrough
  const key = `${epoch}:${source?.generation ?? 'raw'}:${source?.prefix ?? 0}:${tip}`
  const identity = observed?.identity ?? null
  const incarnation = observed ? observedHistoryIncarnation(observed, epoch, 0) : null
  const outcomeIncarnation =
    source && observed ? observedHistoryIncarnation(observed, epoch, source.generation) : null
  if (
    !refresh &&
    (!observed ||
      !observedHistoryCovered(observed, epoch, 0, rawThrough) ||
      (source && !outcomeIncarnation))
  ) {
    throw new Error('chat retirement history is not ready')
  }
  const coverageKey = `${key}:${refresh ? 'refresh' : incarnation}:${refresh ? '' : (outcomeIncarnation ?? '')}`
  const cache = access?.personalStops
  let saved = cache?.get(sessionId)
  if (refresh || saved?.key !== coverageKey) {
    const context = source
      ? db
          .prepare(`SELECT seq, field, entry_key, format, ordinal, value_json, deleted
      FROM journal_outcomes WHERE generation = ? AND field = '$' AND entry_key = '"contextBoundary"'
      AND seq <= ? ORDER BY seq DESC LIMIT 1`)
          .get(source.generation, source.through)
      : undefined
    let boundary = 1
    if (context) {
      const value = decodeJournalOutcome(context)
      boundary = outcomeFormat1StoredScalars.shape.contextBoundary
        .unwrap()
        .parse(JSON.parse(value.json))
    } else if (source?.marker !== 5) {
      const row = refresh
        ? db
            .prepare(`SELECT row_json FROM journal_rows WHERE session_id = ? AND epoch = ?
          AND seq <= ? AND ${CONTEXT_ROWS} ORDER BY seq DESC LIMIT 1`)
            .get(sessionId, epoch, rawThrough)
        : db
            .prepare(`SELECT r.row_json FROM journal_history_locators l JOIN journal_rows r
          ON r.session_id = l.session_id AND r.epoch = l.epoch AND r.seq = l.seq
          WHERE l.session_id = ? AND l.epoch = ? AND l.generation = 0 AND l.incarnation = ?
          AND l.kind IN (2, 3) AND l.seq <= ? ORDER BY l.seq DESC LIMIT 1`)
            .get(sessionId, epoch, incarnation, rawThrough)
      if (row) {
        const parsed = parseJournalRow(String(row.row_json))
        if (!parsed.ok) {
          throw new Error('chat context history is unreadable')
        }
        boundary = parsed.row.seq
      }
    }
    const previous = saved
    const incremental =
      !refresh &&
      previous !== undefined &&
      previous.identity === identity &&
      previous.frontier.boundary === boundary &&
      previous.rawThrough <= rawThrough &&
      previous.outcomeThrough <= (source?.through ?? 0)
    const frontier = incremental ? previous.frontier : emptyJournalPersonalStops(boundary)
    frontier.sourceIdentity = identity
    const rawFrom = incremental ? previous.rawThrough + 1 : boundary
    try {
      const rows = refresh
        ? db
            .prepare(`SELECT row_json FROM journal_rows WHERE session_id = ? AND epoch = ?
          AND seq >= ? AND seq <= ? AND ${RAW_STOPS}`)
            .iterate(sessionId, epoch, rawFrom, rawThrough)
        : db
            .prepare(`SELECT r.row_json FROM journal_history_locators l JOIN journal_rows r
          ON r.session_id = l.session_id AND r.epoch = l.epoch AND r.seq = l.seq
          WHERE l.session_id = ? AND l.epoch = ? AND l.generation = 0 AND l.incarnation = ?
          AND l.kind IN (1, 3) AND l.seq >= ? AND l.seq <= ?`)
            .iterate(sessionId, epoch, incarnation, rawFrom, rawThrough)
      for (const row of rows) {
        const parsed = parseJournalRow(String(row.row_json))
        if (!parsed.ok) {
          frontier.complete = false
          continue
        }
        if (parsed.row.kind === 'tombstone' && parsed.row.stopEvent) {
          rememberJournalPersonalStop(frontier, parsed.row.seq, parsed.row.stopEvent)
        }
      }
    } catch {
      frontier.complete = false
    }
    try {
      hydrateOutcomeStops(
        db,
        source,
        frontier,
        incremental ? previous.outcomeThrough : boundary - 1
      )
    } catch {
      frontier.complete = false
    }
    if (
      (!refresh && identity === null) ||
      (identity !== null && identity !== access?.sourceIdentity(sessionId))
    ) {
      frontier.complete = false
    }
    saved = {
      key: coverageKey,
      identity,
      rawThrough,
      outcomeThrough: source?.through ?? 0,
      context: journalContextEpoch(epoch, boundary),
      frontier
    }
    cache?.delete(sessionId)
    if (frontier.complete && identity !== null && access?.retains(sessionId)) {
      cache?.set(sessionId, saved)
    }
  }
  return saved
}
