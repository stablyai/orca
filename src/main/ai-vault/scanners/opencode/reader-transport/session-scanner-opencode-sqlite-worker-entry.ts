import { existsSync } from 'node:fs'
import type { Worker } from 'node:worker_threads'
import { spawnWorkerThread } from '../../../../worker-threads/worker-thread-spawn'
import { findForeignSqliteReaderEntry } from '../../../../foreign-sqlite-readers/foreign-sqlite-reader-entry-path'

export function resolveOpenCodeSqliteWorkerEntryPath(
  runtimeDir = __dirname,
  pathExists: (path: string) => boolean = existsSync
): string {
  return findForeignSqliteReaderEntry(runtimeDir, pathExists)
}

export function createOpenCodeSqliteWorker(): Worker {
  const workerPath = resolveOpenCodeSqliteWorkerEntryPath()
  // Fail synchronously for missing bundles rather than waiting for an impossible worker response.
  if (!existsSync(workerPath)) {
    throw new Error(`OpenCode SQLite worker entry not found: ${workerPath}`)
  }
  return spawnWorkerThread(workerPath)
}
