import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { decodeTerminalHistoryLog, LOG_HEADER_BYTES } from '../storage/terminal-history-log'
import { readTerminalHistoryMetaInDir } from '../storage/terminal-history-metadata'
import type { TerminalHistoryCwdObservation } from '../storage/terminal-history-cwd-observation'
import { readTerminalHistoryLogHeaderGeneration } from '../storage/terminal-history-session-files'
import type { TerminalJournalPosition } from './terminal-journal-operation'

/** The published checkpoint bytes themselves, its fresh matching header and restorable meta. */
export function verifyFinalCheckpoint(dir: string, data: string, generation: number): boolean {
  try {
    const digest = (value: string | Buffer): string =>
      createHash('sha256').update(value).digest('hex')
    const logPath = join(dir, 'output.log')
    return (
      digest(readFileSync(join(dir, 'checkpoint.json'))) === digest(data) &&
      readTerminalHistoryLogHeaderGeneration(logPath) === generation &&
      statSync(logPath).size === LOG_HEADER_BYTES &&
      restorableMeta(dir, undefined)
    )
  } catch {
    return false
  }
}

/** The complete framed log through F, untruncated, with its final note and restorable meta. */
export function verifyFinalRaw(
  dir: string,
  position: TerminalJournalPosition,
  note: TerminalHistoryCwdObservation | undefined
): boolean {
  try {
    const logPath = join(dir, 'output.log')
    const log = decodeTerminalHistoryLog(readFileSync(logPath))
    return (
      statSync(logPath).size === position.logBytes &&
      log !== null &&
      !log.truncatedTail &&
      log.generation === position.generation &&
      restorableMeta(dir, note)
    )
  } catch {
    return false
  }
}

function restorableMeta(dir: string, note: TerminalHistoryCwdObservation | undefined): boolean {
  const read = readTerminalHistoryMetaInDir(dir)
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
