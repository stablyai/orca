import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { decodeTerminalHistoryLog, LOG_HEADER_BYTES } from '../storage/terminal-history-log'
import { readTerminalHistoryMetaInDirAsync } from '../storage/terminal-history-metadata'
import type { TerminalHistoryCwdObservation } from '../storage/terminal-history-cwd-observation'
import { readTerminalHistoryBufferAsync } from '../storage/terminal-history-file-reader'
import {
  TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES,
  TERMINAL_HISTORY_LOG_MAX_BYTES
} from '../storage/terminal-history-file-limits'
import { readTerminalHistoryLogHeader } from '../storage/terminal-history-session-files'
import type { TerminalJournalPosition } from './terminal-journal-operation'

/** The published checkpoint bytes themselves, its fresh matching header and restorable meta. */
export async function verifyFinalCheckpoint(
  dir: string,
  data: string,
  generation: number
): Promise<boolean> {
  try {
    const digest = (value: string | Buffer): string =>
      createHash('sha256').update(value).digest('hex')
    const published = await readTerminalHistoryBufferAsync(
      join(dir, 'checkpoint.json'),
      TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES
    )
    if (digest(published) !== digest(data)) {
      return false
    }
    const header = await readTerminalHistoryLogHeader(join(dir, 'output.log'))
    return (
      header?.generation === generation &&
      header.bytes === LOG_HEADER_BYTES &&
      (await restorableMeta(dir, undefined))
    )
  } catch {
    return false
  }
}

/** The complete framed log through F, untruncated, with its final note and restorable meta. */
export async function verifyFinalRaw(
  dir: string,
  position: TerminalJournalPosition,
  note: TerminalHistoryCwdObservation | undefined
): Promise<boolean> {
  try {
    const bytes = await readTerminalHistoryBufferAsync(
      join(dir, 'output.log'),
      TERMINAL_HISTORY_LOG_MAX_BYTES
    )
    const log = decodeTerminalHistoryLog(bytes)
    return (
      bytes.length === position.logBytes &&
      log !== null &&
      !log.truncatedTail &&
      log.generation === position.generation &&
      (await restorableMeta(dir, note))
    )
  } catch {
    return false
  }
}

async function restorableMeta(
  dir: string,
  note: TerminalHistoryCwdObservation | undefined
): Promise<boolean> {
  const read = await readTerminalHistoryMetaInDirAsync(dir)
  if (read.status !== 'readable' || read.meta.endedAt !== null) {
    return false
  }
  const saved = read.meta.cwdObservation
  return (
    note === undefined ||
    (saved?.cwd === note.cwd &&
      saved.generation === note.generation &&
      saved.logBytes === note.logBytes)
  )
}
