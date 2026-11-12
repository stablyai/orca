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
import { TerminalHistorySessionWriter } from '../storage/terminal-history-session-writer'
import { clearReplayableTerminalHistorySessionFiles } from '../storage/terminal-history-session-files'
import {
  newTerminalHistoryMeta,
  writeTerminalHistoryMeta
} from '../storage/terminal-history-metadata'

export type TerminalJournalSource = {
  dir: string
  /** Log and checkpoint generation of the committed cut; a checkpoint exists only after a fold. */
  generation: number
  folded: boolean
  logBytes: number
  pending: readonly PendingOutputRecord[]
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
  if (source.logBytes > LOG_HEADER_BYTES) {
    const buffer = await readTerminalHistoryBufferAsync(
      join(source.dir, 'output.log'),
      TERMINAL_HISTORY_LOG_MAX_BYTES
    )
    // Appends past the cut belong to later records the caller already holds.
    const log = decodeTerminalHistoryLog(buffer.subarray(0, source.logBytes))
    if (!log || log.truncatedTail || log.generation !== source.generation) {
      return null
    }
    logged = log.batches.flatMap((batch) => batch.records)
  }
  const emulator = new HeadlessEmulator({
    cols: checkpoint?.cols ?? source.origin.cols,
    rows: checkpoint?.rows ?? source.origin.rows,
    scrollback: RETAINED_HISTORY_ROWS,
    wslDistro: source.origin.wslDistro,
    windowsPty: historyReplayWindowsPty(DAEMON_HISTORY_RESIZE_MODEL)
  })
  try {
    const replayed = await replayTerminalHistory(
      emulator,
      checkpoint,
      concatRecords(logged, source.pending),
      opts.isCanceled
    )
    return replayed ? emulator.getSnapshot({ scrollbackRows: opts.scrollbackRows }) : null
  } finally {
    emulator.dispose()
  }
}

function* concatRecords(
  first: readonly PendingOutputRecord[],
  second: readonly PendingOutputRecord[]
): Generator<PendingOutputRecord> {
  yield* first
  yield* second
}

/** An explicit new physical origin: predecessor replay files go, fresh metadata, generation 0. */
export function openTerminalJournalOrigin(
  dir: string,
  origin: { cwd: string; cols: number; rows: number }
): TerminalHistorySessionWriter {
  clearReplayableTerminalHistorySessionFiles(dir)
  writeTerminalHistoryMeta(
    dir,
    newTerminalHistoryMeta(
      { cwd: origin.cwd, cols: origin.cols, rows: origin.rows },
      DAEMON_HISTORY_RESIZE_MODEL
    )
  )
  return new TerminalHistorySessionWriter(dir, true)
}
