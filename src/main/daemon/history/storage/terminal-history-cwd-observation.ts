import { decodeTerminalHistoryLog, LOG_HEADER_BYTES } from './terminal-history-log'

/**
 * A probed folder saved beside history: it applies after the first `logBytes` of the
 * `generation` log and before every later record, so a later real OSC 7 still wins.
 */
export type TerminalHistoryCwdObservation = {
  cwd: string
  generation: number
  logBytes: number
}

export function isTerminalHistoryCwdObservation(
  value: unknown
): value is TerminalHistoryCwdObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const note = value as Partial<TerminalHistoryCwdObservation>
  return (
    typeof note.cwd === 'string' &&
    note.cwd.length > 0 &&
    Number.isSafeInteger(note.generation) &&
    note.generation! >= 0 &&
    Number.isSafeInteger(note.logBytes) &&
    note.logBytes! >= LOG_HEADER_BYTES
  )
}

/** A literal absolute folder this host can start in; WSL UNC and drvfs spellings stay as given. */
export function isLiteralHostCwd(cwd: unknown, platform = process.platform): cwd is string {
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.includes('\0')) {
    return false
  }
  if (platform === 'win32') {
    return /^[A-Za-z]:[\\/]/.test(cwd) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(cwd)
  }
  return cwd.startsWith('/')
}

/**
 * The replay index a saved note applies at, or null when it does not qualify this exact log:
 * another generation, a position past the log, or a prefix that is not whole frames.
 */
export function cwdObservationRecordIndex(
  note: TerminalHistoryCwdObservation,
  log: Buffer,
  generation: number
): number | null {
  if (note.generation !== generation || note.logBytes > log.length) {
    return null
  }
  const prefix = decodeTerminalHistoryLog(log.subarray(0, note.logBytes))
  if (!prefix || prefix.truncatedTail || prefix.generation !== generation) {
    return null
  }
  return prefix.batches.reduce((count, batch) => count + batch.records.length, 0)
}
