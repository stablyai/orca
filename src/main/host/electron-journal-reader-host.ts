import { UtilityWorkerHost } from '../utility-worker-host/utility-worker-host'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../worker-threads/worker-thread-entry-path'
import { JOURNAL_SQL_READER_HOST_NAME } from '../native-chat/agent-session-journal/journal-sql-reader-host-name'
import { setJournalSqlReaderSpawner } from '../native-chat/agent-session-journal/journal-sql-reader-spawn'
import {
  journalReaderRequestData,
  readJournalReaderRequests
} from '../native-chat/agent-session-journal/journal-sql-reader-requests'
import { join } from 'node:path'
import { spawnWorkerThread } from '../worker-threads/worker-thread-spawn'
import { resolveObservabilityConsent } from '../observability'
import { getLogsDirectory } from '../observability/logs-directory'

/** Chat reads can hold hundreds of MB; outside main's process they can't fill its V8 cage. */
export function installElectronJournalReaderHost(): void {
  const host = new UtilityWorkerHost(
    JOURNAL_SQL_READER_HOST_NAME,
    // Resolved at first spawn: the packaged layout is known only after app environment setup.
    () =>
      resolveWorkerThreadEntryPath(
        currentWorkerEntryLayout(__dirname),
        'utility-worker-host-entry.js'
      ),
    ({ filename, name, workerData }) =>
      spawnWorkerThread(filename, { name, workerData, execArgv: [] }),
    (workers) => journalReaderRequestData(readJournalReaderRequests(workers))
  )
  setJournalSqlReaderSpawner((filename, workerData) =>
    host.spawn({
      filename,
      name: 'orca-journal-sql-reader',
      workerData,
      ...(resolveObservabilityConsent().localFileEnabled
        ? { largeSendLog: join(getLogsDirectory(), 'worker-large-sends.ndjson') }
        : {})
    })
  )
}
