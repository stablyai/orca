import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveWorkerThreadEntryPath, type WorkerEntryLayout } from '../worker-thread-entry-path'

// Electron-free: the OpenCode scanner reaches this from plain-Node processes too.

export const FOREIGN_SQLITE_READER_ENTRY_FILENAME = 'foreign-sqlite-reader-entry.js'

export function findForeignSqliteReaderEntry(
  runtimeDir: string,
  pathExists: (path: string) => boolean = existsSync
): string {
  const adjacent = join(runtimeDir, FOREIGN_SQLITE_READER_ENTRY_FILENAME)
  // Shared chunks sit one directory below the built worker entries.
  const parent = join(runtimeDir, '..', FOREIGN_SQLITE_READER_ENTRY_FILENAME)
  return pathExists(adjacent) || !pathExists(parent) ? adjacent : parent
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
