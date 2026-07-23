import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { decodeLogHeader, LOG_HEADER_BYTES } from './terminal-history-log'
import { TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES } from './terminal-history-file-limits'
import { readTerminalHistoryJson } from './terminal-history-file-reader'

export type TerminalHistoryLogState = {
  checkpointPath: string
  logPath: string
  /** Null until a warm writer resolves the existing log on first append. */
  logGeneration: number | null
  /** Null until resolved alongside the generation. */
  logBytes: number | null
}

export function resolveTerminalHistoryLogState(writer: TerminalHistoryLogState): void {
  if (writer.logBytes !== null && writer.logGeneration !== null) {
    return
  }
  let headerGeneration: number | null = null
  let size = 0
  try {
    const fd = openSync(writer.logPath, 'r')
    try {
      size = fstatSync(fd).size
      const header = Buffer.alloc(LOG_HEADER_BYTES)
      if (readSync(fd, header, 0, LOG_HEADER_BYTES, 0) === LOG_HEADER_BYTES) {
        headerGeneration = decodeLogHeader(header)
      }
    } finally {
      closeSync(fd)
    }
  } catch {
    // Missing log file starts a fresh generation below.
  }
  if (headerGeneration !== null) {
    writer.logGeneration = headerGeneration
    writer.logBytes = size
    return
  }
  // Why: a zero byte count makes the next append replace a corrupt or headerless log.
  writer.logBytes = 0
  writer.logGeneration = readCheckpointGeneration(writer.checkpointPath) ?? 0
}

function readCheckpointGeneration(checkpointPath: string): number | null {
  try {
    const checkpoint = readTerminalHistoryJson<{ generation?: unknown }>(
      checkpointPath,
      TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES
    )
    return typeof checkpoint.generation === 'number' ? checkpoint.generation : null
  } catch {
    return null
  }
}
