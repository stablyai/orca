import { promises as fsPromises } from 'node:fs'
import { errnoCodeOrUnknown } from '../../../../shared/errno-code'
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
import {
  readTerminalHistoryBufferAsync,
  readTerminalHistoryJsonAsync
} from '../storage/terminal-history-file-reader'
import {
  TERMINAL_HISTORY_LOG_MAX_BYTES,
  TERMINAL_HISTORY_META_MAX_BYTES
} from '../storage/terminal-history-file-limits'
import { readTerminalHistoryCheckpoint } from '../restoration/terminal-history-checkpoint-reader'
import { replayTerminalHistory } from '../restoration/terminal-history-replay'
import type { ReplayRecordSource } from '../restoration/cold-restore-replay-writer'
import type { RevocablePendingSource } from './terminal-history-pending-source'
import { detachTerminalSnapshotStrings } from './terminal-history-detached-snapshot'
import { TerminalHistorySessionWriter } from '../storage/terminal-history-session-writer'
import {
  clearLegacyTerminalHistoryScrollback,
  hasReplayableTerminalHistorySessionFiles,
  readTerminalHistoryLogHeader
} from '../storage/terminal-history-session-files'
import {
  newTerminalHistoryMeta,
  replaceTerminalHistoryMetaOwned
} from '../storage/terminal-history-metadata'
import {
  cwdObservationRecordIndex,
  isTerminalHistoryCwdObservation,
  type TerminalHistoryCwdObservation
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
 * metadata without a note follows, then the generation-0 writer. `isOwner` is checked before each
 * destructive step; the writer keeps `isAdmitted` for its lifetime.
 */
export async function openTerminalJournalOrigin(
  dir: string,
  origin: { cwd: string; cols: number; rows: number },
  isOwner: () => boolean,
  isAdmitted: () => boolean
): Promise<TerminalHistorySessionWriter> {
  for (const name of ['checkpoint.json', 'scrollback.bin', 'output.log']) {
    assertOriginOwner(isOwner)
    try {
      await fsPromises.unlink(join(dir, name))
    } catch (error) {
      if (errnoCodeOrUnknown(error) !== 'ENOENT') {
        throw new Error('terminal_history_origin_reset_failed')
      }
    }
  }
  if (await hasReplayableTerminalHistorySessionFiles(dir)) {
    throw new Error('terminal_history_origin_reset_failed')
  }
  const fresh = newTerminalHistoryMeta(
    { cwd: origin.cwd, cols: origin.cols, rows: origin.rows },
    DAEMON_HISTORY_RESIZE_MODEL
  )
  if ((await replaceTerminalHistoryMetaOwned(dir, () => fresh, isOwner)) !== 'replaced') {
    throw new Error('terminal_history_origin_meta_failed')
  }
  return TerminalHistorySessionWriter.openHost(dir, { generation: 0, bytes: 0 }, isAdmitted)
}

/**
 * A seeded origin replaces predecessor recovery through the existing staged checkpoint, so a crash
 * or failed write before its rename leaves the predecessor files as the sole recovery.
 */
export async function publishTerminalJournalSeedOrigin(
  dir: string,
  origin: { cwd: string; cols: number; rows: number; wslDistro: string | undefined },
  seed: readonly PendingOutputRecord[],
  isOwner: () => boolean,
  isAdmitted: () => boolean
): Promise<TerminalHistorySessionWriter> {
  // Above every readable predecessor generation, so no predecessor log or note can match it.
  const lineage = await readTerminalJournalLineage(dir)
  const generation = lineage.generation + 1
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
  const writer = await TerminalHistorySessionWriter.openHost(dir, lineage.log, isAdmitted)
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
  assertOriginOwner(isOwner)
  await clearLegacyTerminalHistoryScrollback(dir)
  const fresh = newTerminalHistoryMeta(
    { cwd: origin.cwd, cols: origin.cols, rows: origin.rows },
    DAEMON_HISTORY_RESIZE_MODEL
  )
  if ((await replaceTerminalHistoryMetaOwned(dir, () => fresh, isOwner)) !== 'replaced') {
    throw new Error('terminal_history_origin_meta_failed')
  }
  return writer
}

function assertOriginOwner(isOwner: () => boolean): void {
  if (!isOwner()) {
    throw new Error('terminal_history_admission_closed')
  }
}

/**
 * The highest generation the predecessor's checkpoint, log header or note can claim. A readable
 * checkpoint covers a torn or older header; required lineage nobody can read is unavailable. The
 * log state is what a writer would resolve from these files before its strict replacement.
 */
async function readTerminalJournalLineage(
  dir: string
): Promise<{ generation: number; log: { generation: number; bytes: number } }> {
  const generations = [0]
  const checkpoint = await readTerminalHistoryCheckpoint(join(dir, 'checkpoint.json'))
  const checkpointGeneration =
    checkpoint.status === 'readable' && typeof checkpoint.checkpoint.generation === 'number'
      ? checkpoint.checkpoint.generation
      : null
  if (checkpointGeneration !== null) {
    generations.push(checkpointGeneration)
  }
  const header = await readTerminalHistoryLogHeader(join(dir, 'output.log'))
  if (header && header.generation !== null) {
    generations.push(header.generation)
  }
  if (checkpoint.status === 'unreadable' && (!header || header.generation === null)) {
    throw new TerminalHistoryUnavailableError()
  }
  const note = await readSavedCwdObservation(dir)
  if (note) {
    generations.push(note.generation)
  }
  return {
    generation: Math.max(...generations),
    log:
      header && header.generation !== null
        ? { generation: header.generation, bytes: header.bytes }
        : { generation: checkpointGeneration ?? 0, bytes: 0 }
  }
}

async function readSavedCwdObservation(dir: string): Promise<TerminalHistoryCwdObservation | null> {
  try {
    const meta = await readTerminalHistoryJsonAsync<unknown>(
      join(dir, 'meta.json'),
      TERMINAL_HISTORY_META_MAX_BYTES
    )
    return typeof meta === 'object' &&
      meta !== null &&
      'cwdObservation' in meta &&
      isTerminalHistoryCwdObservation(meta.cwdObservation)
      ? meta.cwdObservation
      : null
  } catch {
    return null
  }
}
