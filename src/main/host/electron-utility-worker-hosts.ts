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
import { CHILD_SPAWNER_HOST_NAME } from '../utility-worker-host/child-spawner-host-name'
import { UTILITY_WORKER_NO_HEAP_SAMPLING_ARG } from '../utility-worker-host/utility-worker-host-protocol'
import { installIsolatedChildSpawner } from '../worker-thread-child-process/worker-thread-child-process'
import { pruneOrphanedSpawnRecords } from '../worker-thread-child-process/lost-spawn-processes'
import { resolveProviderExecPath } from '../provider-process/provider-process-supervisor'
import { setDefaultProcessLaunch } from '@orca/process-host/default-process-launch'
import { launchProcessSpecOnWorker } from '../git/command-runner/process-capture/process-spec-worker-launch'

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

/**
 * Linux: short-lived children (git, gh, probes) start from a utility process, whose fd table
 * Chromium builds fresh, so none of them can hold main's Chromium sockets after main dies. When
 * the host can't start, its in-process fallback starts them through the fd-closing helper instead.
 */
export function installElectronChildSpawnerHost(): void {
  if (process.platform !== 'linux') {
    return
  }
  const host = new UtilityWorkerHost(
    CHILD_SPAWNER_HOST_NAME,
    hostEntry,
    ({ filename, name, workerData, inProcessWorkerData }) =>
      spawnWorkerThread(filename, {
        name,
        workerData:
          inProcessWorkerData && typeof workerData === 'object'
            ? { ...workerData, ...inProcessWorkerData }
            : workerData
      }),
    undefined,
    undefined,
    undefined,
    [UTILITY_WORKER_NO_HEAP_SAMPLING_ARG]
  )
  installIsolatedChildSpawner(() =>
    host.spawn({
      filename: resolveWorkerThreadEntryPath(
        currentWorkerEntryLayout(__dirname),
        'worker-thread-child-process-entry.js'
      ),
      name: 'orca-child-process-spawner',
      workerData: { recordSpawns: true },
      // Only a worker in the launcher records pids; in main its messages can't be lost in transit.
      inProcessWorkerData: {
        fdClosingHelper: resolveProviderExecPath('linux'),
        recordSpawns: false
      }
    })
  )
  void pruneOrphanedSpawnRecords()
  // Every runProcess without its own launch (git probes, gh, ps, lsof...) starts there too.
  setDefaultProcessLaunch((spec, onTerminated) =>
    launchProcessSpecOnWorker(spec, undefined, onTerminated, !spec.onChildTerminated, true)
  )
}
