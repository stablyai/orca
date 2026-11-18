import { spawnWorkerThread } from '../../worker-threads/worker-thread-spawn'
import type { HostedWorkerThread } from '../../utility-worker-host/utility-worker-host-protocol'

export type JournalSqlReaderWorker = HostedWorkerThread
export type JournalSqlReaderWorkerData = { filename: string; originalFilename: string }
export type JournalSqlReaderSpawner = (
  workerPath: string,
  workerData: JournalSqlReaderWorkerData
) => JournalSqlReaderWorker

const spawnJournalSqlReaderThread: JournalSqlReaderSpawner = (workerPath, workerData) =>
  spawnWorkerThread(workerPath, { name: 'orca-journal-sql-reader', workerData, execArgv: [] })

let spawner = spawnJournalSqlReaderThread

/** Electron main hosts readers in a utility process; orcad and tests keep them as threads. */
export function setJournalSqlReaderSpawner(next: JournalSqlReaderSpawner): void {
  spawner = next
}

export function spawnJournalSqlReader(
  workerPath: string,
  workerData: JournalSqlReaderWorkerData
): JournalSqlReaderWorker {
  return spawner(workerPath, workerData)
}
