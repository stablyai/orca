import { spawnWorkerThread } from '../../worker-threads/worker-thread-spawn'
import type { HostedWorkerThread } from '../../utility-worker-host/utility-worker-host-protocol'

export type JournalSqlReaderWorker = HostedWorkerThread
export type JournalSqlReaderWorkerData = { filename: string; originalFilename: string }
/** Shared memory can't cross a process, so only a reader running in main's process gets it. */
export type JournalSqlReaderInProcessData = { replyCredit: unknown }
export type JournalSqlReaderSpawner = (
  workerPath: string,
  workerData: JournalSqlReaderWorkerData,
  inProcessWorkerData?: JournalSqlReaderInProcessData
) => JournalSqlReaderWorker

const spawnJournalSqlReaderThread: JournalSqlReaderSpawner = (workerPath, workerData, inProcess) =>
  spawnWorkerThread(workerPath, {
    name: 'orca-journal-sql-reader',
    workerData: { ...workerData, ...inProcess },
    execArgv: []
  })

let spawner = spawnJournalSqlReaderThread

/** Electron main hosts readers in a utility process; orcad and tests keep them as threads. */
export function setJournalSqlReaderSpawner(next: JournalSqlReaderSpawner): void {
  spawner = next
}

export function spawnJournalSqlReader(
  workerPath: string,
  workerData: JournalSqlReaderWorkerData,
  inProcessWorkerData?: JournalSqlReaderInProcessData
): JournalSqlReaderWorker {
  return spawner(workerPath, workerData, inProcessWorkerData)
}
