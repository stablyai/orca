import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { HeadlessEmulator } from '../../emulation/headless-emulator'
import { DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT as RETAINED_HISTORY_ROWS } from '../../../../shared/terminal/replay/terminal-scrollback-policy'
import {
  DAEMON_HISTORY_RESIZE_MODEL,
  historyReplayWindowsPty
} from '../../protocol/daemon-history-replay-pty'
import type { TerminalCheckpointFile } from '../../protocol/daemon-checkpoint-file'
import type { PendingOutputRecord } from '../../protocol/daemon-rpc-contract'
import type { TerminalSnapshot } from '../../protocol/terminal-snapshot'
import { decodeTerminalHistoryLog, LOG_HEADER_BYTES } from '../storage/terminal-history-log'
import { readTerminalHistoryBufferAsync } from '../storage/terminal-history-file-reader'
import { TERMINAL_HISTORY_LOG_MAX_BYTES } from '../storage/terminal-history-file-limits'
import { readTerminalHistoryCheckpoint } from '../restoration/terminal-history-checkpoint-reader'
import { replayTerminalHistory } from '../restoration/terminal-history-replay'
import type { ReplayRecordSource } from '../restoration/cold-restore-replay-writer'
import type { RevocablePendingSource } from './terminal-history-pending-source'
import { detachTerminalSnapshotStrings } from './terminal-history-detached-snapshot'
import { TerminalHistorySessionWriter } from '../storage/terminal-history-session-writer'
import {
  clearLegacyTerminalHistoryScrollback,
  hasReplayableTerminalHistorySessionFiles,
  readTerminalHistoryLogHeaderGeneration
} from '../storage/terminal-history-session-files'
import {
  newTerminalHistoryMeta,
  readTerminalHistoryMetaFromDir,
  replaceTerminalHistoryMetaOwned
} from '../storage/terminal-history-metadata'
import {
  cwdObservationRecordIndex,
  isTerminalHistoryCwdObservation
} from '../storage/terminal-history-cwd-observation'
import { TerminalHistoryUnavailableError } from '../../protocol/daemon-history-protocol'
import type { TerminalJournalCwdNote } from './terminal-session-journal-contract'

export type TerminalJournalSource = {
  dir: string
  /** Log and checkpoint generation of the committed cut; a checkpoint exists only after a fold. */
  generation: number
  folded: boolean
  logBytes: number
  /** Absolute record index where `pending` begins, and the folder note captured with the cut. */
  firstRecord?: number
  cwdNote?: TerminalJournalCwdNote | null
  /** Read per slice; a revocable source also owns the parser it feeds. */
  pending: ReplayRecordSource | RevocablePendingSource
  origin: { cols: number; rows: number; wslDistro: string | undefined }
}

/**
 * Raw checkpoint segments, the matching committed log prefix and the uncommitted records, all in
 * one parser. Reads only files; a header or generation mismatch is unavailable, never a guess.
 */
export async function replayTerminalJournalSource(
  source: TerminalJournalSource,
  opts: { scrollbackRows?: number; isCanceled?: () => boolean } = {}
): Promise<TerminalSnapshot | null> {
  let checkpoint: TerminalCheckpointFile | null = null
  if (source.folded) {
    const read = await readTerminalHistoryCheckpoint(join(source.dir, 'checkpoint.json'))
    if (read.status !== 'readable' || read.checkpoint.generation !== source.generation) {
      return null
    }
    checkpoint = read.checkpoint
  }
  let logged: PendingOutputRecord[] = []
  let logPrefix: Buffer | null = null
  if (source.logBytes > LOG_HEADER_BYTES) {
    const buffer = await readTerminalHistoryBufferAsync(
      join(source.dir, 'output.log'),
      TERMINAL_HISTORY_LOG_MAX_BYTES
    )
    // Appends past the cut belong to later records the caller already holds.
    logPrefix = buffer.subarray(0, source.logBytes)
    const log = decodeTerminalHistoryLog(logPrefix)
    if (!log || log.truncatedTail || log.generation !== source.generation) {
      return null
    }
    logged = log.batches.flatMap((batch) => batch.records)
  }
  const cwdAt = journalCwdNoteIndex(source, logPrefix, logged.length)
  const emulator = new HeadlessEmulator({
    cols: checkpoint?.cols ?? source.origin.cols,
    rows: checkpoint?.rows ?? source.origin.rows,
    scrollback: RETAINED_HISTORY_ROWS,
    wslDistro: source.origin.wslDistro,
    windowsPty: historyReplayWindowsPty(DAEMON_HISTORY_RESIZE_MODEL)
  })
  const pending = typeof source.pending === 'function' ? source.pending : source.pending.at
  const revocable = typeof source.pending === 'function' ? null : source.pending
  let disposed = false
  const dispose = (): void => {
    if (!disposed) {
      disposed = true
      emulator.dispose()
    }
  }
  revocable?.holdParser(dispose)
  try {
    // The checkpoint's cwd is the baseline; a later OSC 7 in the replayed records still wins.
    const replayed = await replayTerminalHistory(
      emulator,
      checkpoint,
      (index) => (index < logged.length ? logged[index] : pending(index - logged.length)),
      () => opts.isCanceled?.() === true || revocable?.revoked === true,
      { baseline: checkpoint?.cwd, ...(cwdAt ? { at: cwdAt } : {}) }
    )
    return replayed && !revocable?.revoked
      ? detachTerminalSnapshotStrings(emulator.getSnapshot({ scrollbackRows: opts.scrollbackRows }))
      : null
  } finally {
    revocable?.holdParser(null)
    dispose()
  }
}

/** Where a captured note applies in this replay; a note of another generation is already folded. */
function journalCwdNoteIndex(
  source: TerminalJournalSource,
  logPrefix: Buffer | null,
  loggedRecords: number
): { index: number; cwd: string } | null {
  const note = source.cwdNote
  if (!note) {
    return null
  }
  if ('record' in note) {
    const offset = Math.max(0, note.record - (source.firstRecord ?? note.record))
    return { index: loggedRecords + offset, cwd: note.cwd }
  }
  if (note.generation !== source.generation || note.logBytes > source.logBytes) {
    return null
  }
  if (note.logBytes <= LOG_HEADER_BYTES || !logPrefix) {
    return { index: 0, cwd: note.cwd }
  }
  const index = cwdObservationRecordIndex(note, logPrefix, source.generation)
  return index === null ? null : { index, cwd: note.cwd }
}

/**
 * An explicit new physical origin. Obsolete replay files go first, under the predecessor's own
 * metadata, so a failed or interrupted reset never pairs old bytes with new geometry; fresh
 * metadata without a note follows, then the generation-0 writer.
 */
export function openTerminalJournalOrigin(
  dir: string,
  origin: { cwd: string; cols: number; rows: number },
  isOwner: () => boolean
): TerminalHistorySessionWriter {
  for (const name of ['checkpoint.json', 'scrollback.bin', 'output.log']) {
    try {
      unlinkSync(join(dir, name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw new Error('terminal_history_origin_reset_failed')
      }
    }
  }
  if (hasReplayableTerminalHistorySessionFiles(dir)) {
    throw new Error('terminal_history_origin_reset_failed')
  }
  const fresh = newTerminalHistoryMeta(
    { cwd: origin.cwd, cols: origin.cols, rows: origin.rows },
    DAEMON_HISTORY_RESIZE_MODEL
  )
  if (replaceTerminalHistoryMetaOwned(dir, () => fresh, isOwner) !== 'replaced') {
    throw new Error('terminal_history_origin_meta_failed')
  }
  return new TerminalHistorySessionWriter(dir, true)
}

/**
 * A seeded origin replaces predecessor recovery through the existing staged checkpoint, so a crash
 * or failed write before its rename leaves the predecessor files as the sole recovery.
 */
export async function publishTerminalJournalSeedOrigin(
  dir: string,
  origin: { cwd: string; cols: number; rows: number; wslDistro: string | undefined },
  seed: readonly PendingOutputRecord[],
  isOwner: () => boolean
): Promise<TerminalHistorySessionWriter> {
  // Above every readable predecessor generation, so no predecessor log or note can match it.
  const generation = (await readTerminalJournalLineageGeneration(dir)) + 1
  if (generation > 0xffffffff) {
    throw new Error('terminal_history_generation_exhausted')
  }
  const snapshot = await replayTerminalJournalSource({
    dir,
    generation: 0,
    folded: false,
    logBytes: 0,
    pending: (index) => seed[index],
    origin
  })
  if (!snapshot) {
    throw new Error('terminal_history_seed_replay_failed')
  }
  const writer = new TerminalHistorySessionWriter(dir, false, undefined, isOwner)
  const result = await writer.checkpointStrict(
    { ...snapshot, cwd: snapshot.cwd ?? origin.cwd },
    { pendingOutputSeq: 0, generation }
  )
  if (result.result === 'too-large') {
    throw new Error('backing_exhausted')
  }
  if (result.result !== 'committed') {
    throw result.error
  }
  clearLegacyTerminalHistoryScrollback(dir)
  const fresh = newTerminalHistoryMeta(
    { cwd: origin.cwd, cols: origin.cols, rows: origin.rows },
    DAEMON_HISTORY_RESIZE_MODEL
  )
  if (replaceTerminalHistoryMetaOwned(dir, () => fresh, isOwner) !== 'replaced') {
    throw new Error('terminal_history_origin_meta_failed')
  }
  return writer
}

/**
 * The highest generation the predecessor's checkpoint, log header or note can claim. A readable
 * checkpoint covers a torn or older header; required lineage nobody can read is unavailable.
 */
async function readTerminalJournalLineageGeneration(dir: string): Promise<number> {
  const generations = [0]
  const checkpoint = await readTerminalHistoryCheckpoint(join(dir, 'checkpoint.json'))
  if (checkpoint.status === 'readable' && typeof checkpoint.checkpoint.generation === 'number') {
    generations.push(checkpoint.checkpoint.generation)
  }
  const header = readTerminalHistoryLogHeaderGeneration(join(dir, 'output.log'))
  if (header !== null) {
    generations.push(header)
  }
  if (checkpoint.status === 'unreadable' && header === null) {
    throw new TerminalHistoryUnavailableError()
  }
  const meta = readTerminalHistoryMetaFromDir(dir)
  if (isTerminalHistoryCwdObservation(meta?.cwdObservation)) {
    generations.push(meta.cwdObservation.generation)
  }
  return Math.max(...generations)
}
