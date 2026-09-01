// Pinned pre-v1 backup writer injected into the agent-catalog v1 schema
// migration (src/shared/agent-catalog-schema-migration.ts). Kept in main
// because it is fs-bound; the migration itself is pure and shared with the CLI.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { durableWriteTempPath, writeFileDurableSync } from '../durable-file-write'
import type { PinnedBackupResult } from '../../shared/agent-catalog-schema-migration'

export function pinnedPreV1BackupPath(dataFile: string): string {
  return `${dataFile}.pre-agent-catalog-v1.backup`
}

export type PinnedPreV1BackupState =
  /** Readable and parses: a real rollback point, keep it. */
  | { state: 'usable' }
  /** Readable but not JSON: demonstrably torn, safe to rewrite. */
  | { state: 'torn' }
  /** EISDIR/EACCES/EIO: not a rollback point, and not safely overwritable either. */
  | { state: 'unreadable'; error: string }

/** Classify an existing pinned backup. Unreadable is its own state: treating it
 *  as usable would claim a rollback point nobody can read, and treating it as
 *  torn would destroy an unknown path on a guess. */
export function classifyPinnedPreV1Backup(backupFile: string): PinnedPreV1BackupState {
  let contents: string
  try {
    contents = readFileSync(backupFile, 'utf-8')
  } catch (error) {
    return { state: 'unreadable', error: error instanceof Error ? error.message : String(error) }
  }
  try {
    JSON.parse(contents)
    return { state: 'usable' }
  } catch {
    return { state: 'torn' }
  }
}

/** Write the exact pre-v1 raw bytes to the pinned backup with the data file's
 *  permissions, fsync the file and its directory, then atomically rename into
 *  place. A usable existing pinned backup is kept (a crash between backup and
 *  first v1 write must not let a second attempt overwrite the original pre-v1
 *  state); a torn one is repaired, since this runs only while the profile is
 *  still pre-v1, so `rawContents` is genuine pre-v1 bytes. */
export function createPinnedPreV1Backup(dataFile: string, rawContents: string): PinnedBackupResult {
  const backupFile = pinnedPreV1BackupPath(dataFile)
  try {
    if (existsSync(backupFile)) {
      const existing = classifyPinnedPreV1Backup(backupFile)
      // PinnedBackupResult cannot express "no pinned backup", and claiming one we
      // cannot read is the bug: fail the migration so the profile stays pre-v1
      // and Settings offers a retry once the path is fixed by hand.
      if (existing.state === 'unreadable') {
        return { ok: false, error: `The pre-update backup could not be read: ${existing.error}` }
      }
      if (existing.state === 'usable') {
        return { ok: true, created: false }
      }
    }
    const mode = statSync(dataFile).mode & 0o777
    writeFileDurableSync(durableWriteTempPath(backupFile), backupFile, rawContents, { mode })
    return { ok: true, created: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
