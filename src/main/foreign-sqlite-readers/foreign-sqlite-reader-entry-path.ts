import { existsSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import {
  resolveWorkerThreadEntryPath,
  type WorkerEntryLayout
} from '../worker-threads/worker-thread-entry-path'

// Electron-free: the OpenCode scanner reaches this from plain-Node processes too.

export const FOREIGN_SQLITE_READER_ENTRY_FILENAME = 'foreign-sqlite-reader-entry.js'

function foreignSqliteReaderEntryCandidates(runtimeDir: string): [string, string] {
  // Shared chunks sit one directory below the built worker entries.
  return [
    join(runtimeDir, FOREIGN_SQLITE_READER_ENTRY_FILENAME),
    join(runtimeDir, '..', FOREIGN_SQLITE_READER_ENTRY_FILENAME)
  ]
}

export function findForeignSqliteReaderEntry(
  runtimeDir: string,
  pathExists: (path: string) => boolean = existsSync
): string {
  const [adjacent, parent] = foreignSqliteReaderEntryCandidates(runtimeDir)
  return pathExists(adjacent) || !pathExists(parent) ? adjacent : parent
}

/** The entry that exists, found off the main thread; null when the bundle is missing. */
export async function locateForeignSqliteReaderEntry(runtimeDir: string): Promise<string | null> {
  for (const candidate of foreignSqliteReaderEntryCandidates(runtimeDir)) {
    if (
      await access(candidate).then(
        () => true,
        () => false
      )
    ) {
      return candidate
    }
  }
  return null
}

export function resolveForeignSqliteReaderEntryPath(
  layout: WorkerEntryLayout,
  pathExists: (path: string) => boolean = existsSync
): string {
  if (layout.isPackaged && layout.resourcesPath) {
    return resolveWorkerThreadEntryPath(layout, FOREIGN_SQLITE_READER_ENTRY_FILENAME)
  }
  return findForeignSqliteReaderEntry(layout.moduleDir, pathExists)
}
