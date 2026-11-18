import { join } from 'node:path'
import { UtilityWorkerHost } from '../utility-worker-host/utility-worker-host'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../worker-threads/worker-thread-entry-path'
import { JOURNAL_SQL_READER_HOST_NAME } from '../native-chat/agent-session-journal/journal-sql-reader-host-name'
import { setJournalSqlReaderSpawner } from '../native-chat/agent-session-journal/journal-sql-reader-spawn'
import { spawnWorkerThread } from '../worker-threads/worker-thread-spawn'
import { resolveObservabilityConsent } from '../observability'
import { getLogsDirectory } from '../observability/logs-directory'
import {
  HEAVY_WORKER_HOST_NAME,
  setHeavyWorkerSpawner
} from '../utility-worker-host/heavy-worker-spawn'

const CRASH_WINDOW_MS = 5 * 60_000

// Resolved at first spawn: the packaged layout is known only after app environment setup.
const hostEntry = (): string =>
  resolveWorkerThreadEntryPath(currentWorkerEntryLayout(__dirname), 'utility-worker-host-entry.js')

const largeSendLog = (): { largeSendLog?: string } =>
  resolveObservabilityConsent().localFileEnabled
    ? { largeSendLog: join(getLogsDirectory(), 'worker-large-sends.ndjson') }
    : {}

/** Chat reads can hold hundreds of MB; outside main's process they can't fill its V8 cage. */
export function installElectronJournalReaderHost(): void {
  const host = new UtilityWorkerHost(JOURNAL_SQL_READER_HOST_NAME, hostEntry, ({ filename, name, workerData }) =>
    spawnWorkerThread(filename, { name, workerData, execArgv: [] })
  )
  setJournalSqlReaderSpawner((filename, workerData) =>
    host.spawn({ filename, name: 'orca-journal-sql-reader', workerData, ...largeSendLog() })
  )
}

/**
 * Whole-transcript parses and tree scans get their own process, apart from chat reads, so an OOM
 * in one never stops the other. Repeated crashes pause it until a user asks again.
 */
export function installElectronHeavyWorkerHost(): void {
  const host = new UtilityWorkerHost(
    HEAVY_WORKER_HOST_NAME,
    hostEntry,
    ({ filename, name, workerData }) => spawnWorkerThread(filename, { name, workerData }),
    {
      crashes: 3,
      windowMs: CRASH_WINDOW_MS,
      message: 'Orca paused this after its background worker crashed 3 times. Try again to restart it.'
    }
  )
  setHeavyWorkerSpawner(
    (filename, { name, workerData }) =>
      // Only tests and unbuilt sources name a URL entry; the host can load built files only.
      filename instanceof URL
        ? spawnWorkerThread(filename, { name, workerData })
        : host.spawn({ filename, name, workerData, ...largeSendLog() }),
    () => host.retry()
  )
}
