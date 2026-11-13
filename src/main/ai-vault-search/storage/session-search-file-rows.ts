import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type { SessionSearchFileRow, SessionSearchFileState } from './session-search-store-types'

// Validate returned column values: the SELECT aliases the columns but cannot guarantee row types.

function numberOrNull(value: SqliteRow[string] | undefined): number | null {
  return typeof value === 'number' ? value : null
}

function fileState(value: SqliteRow[string] | undefined): SessionSearchFileState | null {
  return value === 'current' || value === 'due' || value === 'failed' ? value : null
}

/** A row whose path or state is unreadable is dropped: a partial row could drop or rewrite a file. */
export function readSessionSearchFileRows(rows: readonly SqliteRow[]): SessionSearchFileRow[] {
  const files: SessionSearchFileRow[] = []
  for (const row of rows) {
    const path = row.path
    const state = fileState(row.state)
    const dev = row.dev
    const ino = row.ino
    if (typeof path !== 'string' || state === null) {
      continue
    }
    files.push({
      path,
      identity: typeof dev === 'number' && typeof ino === 'number' ? { dev, ino } : null,
      mtimeMs: numberOrNull(row.mtimeMs) ?? 0,
      sizeBytes: numberOrNull(row.sizeBytes),
      sidecarMtimeMs: numberOrNull(row.sidecarMtimeMs),
      sidecarSizeBytes: numberOrNull(row.sidecarSizeBytes),
      state,
      failCount: numberOrNull(row.failCount) ?? 0,
      failedMtimeMs: numberOrNull(row.failedMtimeMs),
      failedSidecarMtimeMs: numberOrNull(row.failedSidecarMtimeMs),
      failedSidecarSizeBytes: numberOrNull(row.failedSidecarSizeBytes)
    })
  }
  return files
}
