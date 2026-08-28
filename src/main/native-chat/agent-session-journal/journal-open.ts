// Loading a journal from disk: snapshot + log → folded state.
//
// The snapshot is authoritative for the current epoch. Log rows belonging to a
// superseded epoch are dropped rather than merged — a crash between publishing
// a rollover snapshot and rewriting the log is the ordinary way that happens.
// A gap in the surviving sequence is corruption, and the caller rolls the epoch
// rather than rendering a partial timeline.

import { isDeepStrictEqual } from 'node:util'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { findSequenceGap } from './journal-cursor'
import {
  journalSnapshotByteLength,
  readJournalLog,
  readJournalSnapshotFile,
  type JournalSnapshotFile
} from './journal-log-file'
import {
  applyJournalRow,
  createJournalReducerState,
  type JournalReducerState
} from './journal-reducer'
import { journalRowByteLength, type JournalRow } from './journal-row-schema'

export type JournalLoad = {
  state: JournalReducerState
  /** Rows still individually replayable, oldest first. */
  tailRows: JournalRow[]
  /** Highest sequence folded into the snapshot; the tail starts after it. */
  compactedThrough: number
  /** A future schema version was met: no writes, no compaction, no deletion. */
  readOnly: boolean
  /** Set when the surviving prefix is unusable and the caller must roll the epoch. */
  corrupt: boolean
  sizeBytes: number
}

/** Returns null when no journal exists yet for this session. */
export async function loadJournal(
  journalDir: string,
  sessionId: string
): Promise<JournalLoad | null> {
  const snapshotRead = await readJournalSnapshotFile(journalDir)
  const snapshot = snapshotRead.snapshot
  const log = await readJournalLog(journalDir)
  if (snapshotRead.unreadable || log.unreadable) {
    return emptyReadOnlyLoad(sessionId)
  }
  const epoch = resolveEpoch(snapshot, log.rows)
  if (!epoch) {
    return null
  }

  const compactedThrough = snapshot?.epoch === epoch ? snapshot.compactedThrough : 0
  const state = seedState(sessionId, epoch, snapshot?.epoch === epoch ? snapshot : null)
  const liveRows = log.rows.filter((row) => row.epoch === epoch)
  const union = unionBySequence(snapshot?.epoch === epoch ? snapshot.tail : [], liveRows, epoch)
  const tailRows = union.rows

  const oldest = tailRows[0]?.seq ?? compactedThrough + 1
  const gap = findSequenceGap(
    tailRows.map((row) => row.seq),
    oldest
  )
  // A hole below the snapshot boundary is unrecoverable too: the snapshot only
  // covers `compactedThrough`, so a tail that starts above it lost rows.
  const malformedTail = log.malformedPositions.some(
    (position) => position.epoch === epoch && position.sequence > compactedThrough
  )
  const corrupt = union.conflict || malformedTail || Boolean(gap) || oldest > compactedThrough + 1

  for (const row of tailRows) {
    if (row.seq > compactedThrough) {
      applyJournalRow(state, row)
    }
  }
  state.oldestSequence = oldest
  state.lastSequence = Math.max(state.lastSequence, compactedThrough)

  return {
    state,
    tailRows,
    compactedThrough,
    readOnly: false,
    corrupt,
    sizeBytes:
      (snapshot?.epoch === epoch ? journalSnapshotByteLength(snapshot) : 0) +
      tailRows.reduce((total, row) => total + journalRowByteLength(row), 0)
  }
}

function emptyReadOnlyLoad(sessionId: string): JournalLoad {
  const state = createJournalReducerState(sessionId, '')
  return {
    state,
    tailRows: [],
    compactedThrough: 0,
    readOnly: true,
    corrupt: false,
    sizeBytes: 0
  }
}

/** The snapshot names the live epoch; without one, the newest epoch row does. */
function resolveEpoch(snapshot: JournalSnapshotFile | null, rows: JournalRow[]): string | null {
  if (snapshot?.epoch) {
    return snapshot.epoch
  }
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row?.kind === 'epoch') {
      return row.epoch
    }
  }
  return null
}

function seedState(
  sessionId: string,
  epoch: string,
  snapshot: JournalSnapshotFile | null
): JournalReducerState {
  const state = createJournalReducerState(sessionId, epoch)
  if (!snapshot) {
    return state
  }
  for (const item of snapshot.items) {
    state.items.set(item.itemId, item)
  }
  for (const tombstone of snapshot.tombstones ?? []) {
    state.tombstones.set(tombstone.itemId, tombstone.revision)
  }
  for (const submission of snapshot.submissions) {
    state.submissions.set(submission.clientMessageId, { ...submission } as AgentJournalSubmission)
  }
  for (const receipt of snapshot.receipts) {
    state.receipts.set(receipt.clientMessageId, {
      clientMessageId: receipt.clientMessageId,
      providerItemId: receipt.providerItemId,
      cursor: { epoch: receipt.epoch, sequence: receipt.sequence },
      acceptedAt: receipt.acceptedAt
    })
  }
  for (const alias of snapshot.aliases) {
    state.aliases.set(alias.providerItemId, alias.itemId)
  }
  state.lastSequence = snapshot.compactedThrough
  state.oldestSequence = snapshot.compactedThrough + 1
  state.highestFence = snapshot.highestFence ?? 0
  return state
}

/** Merge the snapshot's retained tail with the live log, preferring the log's
 *  copy of any sequence both hold, and dropping rows from a superseded epoch. */
function unionBySequence(
  retained: readonly JournalRow[],
  live: readonly JournalRow[],
  epoch: string
): { rows: JournalRow[]; conflict: boolean } {
  const bySequence = new Map<number, JournalRow>()
  let conflict = false
  const add = (row: JournalRow): void => {
    const existing = bySequence.get(row.seq)
    if (existing && !isDeepStrictEqual(existing, row)) {
      conflict = true
    }
    bySequence.set(row.seq, row)
  }
  for (const row of retained) {
    if (row.epoch === epoch) {
      add(row)
    }
  }
  for (const row of live) {
    add(row)
  }
  return { rows: [...bySequence.values()].sort((a, b) => a.seq - b.seq), conflict }
}
