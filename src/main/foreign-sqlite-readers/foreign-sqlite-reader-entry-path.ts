import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveWorkerThreadEntryPath, type WorkerEntryLayout } from '../worker-thread-entry-path'

// Electron-free: the OpenCode scanner reaches this from plain-Node processes too.

export const FOREIGN_SQLITE_READER_ENTRY_FILENAME = 'foreign-sqlite-reader-entry.js'

/**
 * Find the built entry beside a bundle that runs straight off disk.
 * @param runtimeDir - The calling module's `__dirname`.
 * @returns The first existing candidate, else the adjacent path so the miss names it.
 */
export function findForeignSqliteReaderEntry(
  runtimeDir: string,
  pathExists: (path: string) => boolean = existsSync
): string {
  const adjacent = join(runtimeDir, FOREIGN_SQLITE_READER_ENTRY_FILENAME)
  // Rollup factors shared callers into out/main/chunks; worker entries stay in out/main.
  const parent = join(runtimeDir, '..', FOREIGN_SQLITE_READER_ENTRY_FILENAME)
  return pathExists(adjacent) || !pathExists(parent) ? adjacent : parent
}

/**
 * Resolve the entry for an Electron main-process caller.
 * @param layout - Packaged flag, resources root, and the caller's `__dirname`.
 * @returns The packaged app.asar path, or the on-disk build path.
 */
export function resolveForeignSqliteReaderEntryPath(
  layout: WorkerEntryLayout,
  pathExists: (path: string) => boolean = existsSync
): string {
  if (layout.isPackaged && layout.resourcesPath) {
    return resolveWorkerThreadEntryPath(layout, FOREIGN_SQLITE_READER_ENTRY_FILENAME)
  }
  return findForeignSqliteReaderEntry(layout.moduleDir, pathExists)
}
