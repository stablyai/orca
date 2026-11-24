import { join } from 'node:path'
import { BrowserWindow, ipcMain } from 'electron'
import {
  BACKGROUND_WORKER_IS_PAUSED_CHANNEL,
  BACKGROUND_WORKER_PAUSED_CHANNEL,
  BACKGROUND_WORKER_RESUMED_CHANNEL,
  BACKGROUND_WORKER_RETRY_CHANNEL
} from '../../shared/background-worker/background-worker-pause-channels'
import { UtilityWorkerHost } from '../utility-worker-host/utility-worker-host'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../worker-threads/worker-thread-entry-path'
import { JOURNAL_SQL_READER_HOST_NAME } from '../native-chat/agent-session-journal/journal-sql-reader-host-name'
import { setJournalSqlReaderSpawner } from '../native-chat/agent-session-journal/journal-sql-reader-spawn'
import { JOURNAL_READER_REPLY_CREDIT_BYTES } from '../native-chat/agent-session-journal/journal-sql-reader-reply-credit'
import {
  journalReaderRequestData,
  readJournalReaderRequests
} from '../native-chat/agent-session-journal/journal-sql-reader-requests'
import { spawnWorkerThread } from '../worker-threads/worker-thread-spawn'
import { resolveObservabilityConsent } from '../observability'
import { getLogsDirectory } from '../observability/logs-directory'
import { setHeavyWorkerHost } from '../utility-worker-host/heavy-worker-spawn'
import { HEAVY_WORKER_HOST_NAME } from '../utility-worker-host/heavy-worker-host-name'

const CRASH_LIMIT = 3
const CRASH_WINDOW_MS = 5 * 60_000

function broadcast(channel: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue
    }
    try {
      window.webContents.send(channel)
    } catch {
      // A renderer can disappear between isDestroyed() and send().
    }
  }
}

// Resolved at first spawn: the packaged layout is known only after app environment setup.
const hostEntry = (): string =>
  resolveWorkerThreadEntryPath(currentWorkerEntryLayout(__dirname), 'utility-worker-host-entry.js')

const largeSendLog = (): { largeSendLog?: string } =>
  resolveObservabilityConsent().localFileEnabled
    ? { largeSendLog: join(getLogsDirectory(), 'worker-large-sends.ndjson') }
    : {}

/** Chat reads can hold hundreds of MB; outside main's process they can't fill its V8 cage. */
export function installElectronJournalReaderHost(): void {
  const host = new UtilityWorkerHost(
    JOURNAL_SQL_READER_HOST_NAME,
    hostEntry,
    ({ filename, name, workerData, inProcessWorkerData }) =>
      spawnWorkerThread(filename, {
        name,
        workerData:
          inProcessWorkerData && typeof workerData === 'object'
            ? { ...workerData, ...inProcessWorkerData }
            : workerData,
        execArgv: []
      }),
    (workers) => journalReaderRequestData(readJournalReaderRequests(workers)),
    undefined,
    // Hosted replies past this wait in the reader process; in-process readers use shared credit.
    JOURNAL_READER_REPLY_CREDIT_BYTES
  )
  setJournalSqlReaderSpawner((filename, workerData, inProcessWorkerData) =>
    host.spawn({
      filename,
      name: 'orca-journal-sql-reader',
      workerData,
      ...(inProcessWorkerData ? { inProcessWorkerData } : {}),
      ...largeSendLog()
    })
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
    undefined,
    {
      crashes: CRASH_LIMIT,
      windowMs: CRASH_WINDOW_MS,
      message: `Paused after crashing ${CRASH_LIMIT} times in 5 minutes. Try again to resume.`,
      onPause: () => broadcast(BACKGROUND_WORKER_PAUSED_CHANNEL),
      onResume: () => broadcast(BACKGROUND_WORKER_RESUMED_CHANNEL)
    }
  )
  ipcMain.removeHandler(BACKGROUND_WORKER_RETRY_CHANNEL)
  ipcMain.handle(BACKGROUND_WORKER_RETRY_CHANNEL, () => host.retry())
  ipcMain.removeHandler(BACKGROUND_WORKER_IS_PAUSED_CHANNEL)
  ipcMain.handle(BACKGROUND_WORKER_IS_PAUSED_CHANNEL, () => host.pauseMessage !== null)
  setHeavyWorkerHost({
    spawn: (filename, { name, workerData }) =>
      // Only tests and unbuilt sources name a URL entry; the host can load built files only.
      filename instanceof URL
        ? spawnWorkerThread(filename, { name, workerData })
        : host.spawn({ filename, name, workerData, ...largeSendLog() }),
    retry: () => host.retry(),
    pauseMessage: () => host.pauseMessage
  })
}
