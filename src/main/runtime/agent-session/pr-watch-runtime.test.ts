// @orca-isolated-worker -- Watch admission and committed shutdown are process-wide and one-way.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import * as profilePaths from '../../orca-profiles/profile-storage-paths'
import { PRWatchService } from '../../github/pr-watch/pr-watch-service'
import * as refresh from '../../github/pull-requests/refresh/pr-refresh-coordinator'
import { JournalSqlReaderPool } from '../../native-chat/agent-session-journal/journal-sql-reader-pool'
import { JournalSqlDatabase } from '../../native-chat/agent-session-journal/database/journal-sql-database'
import {
  journalSqlReaderPath,
  journalSqlWorkerPath
} from '../../native-chat/agent-session-journal/journal-sql-worker-bundle.test-fixture'
import { journalDomainDatabasePath } from '../../native-chat/agent-session-journal/database/journal-domain-database'
import { createStructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { openTestAgentSessionRecordStoreSlot } from './records/agent-session-record-store-test-harness'
import {
  closeAgentSessionRecordStoreDatabase,
  retireAgentSessionRecordStore
} from './records/agent-session-record-store-slot'
import * as watches from './pr-watch-runtime'
import { recordStructuredAgentSessionHostInstallRefusal } from './structured-agent-session-host-refusal'
import { OrcaRuntimeService } from '../orca-runtime'
import { localAgentSessionRecordStoreLocation } from './records/local-agent-session-record-store-startup-open'
import { markHostShuttingDown } from '../../startup/quit/host-shutdown-state'
import type * as HostRuntime from './structured-agent-session-runtime'

// The chat host's own installation is covered elsewhere; this exercises what installation does next.
vi.mock('./structured-agent-session-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof HostRuntime>()),
  ensureStructuredAgentSessionHost: vi.fn(async () => undefined)
}))

let stateDirectory: string
let runtime: OrcaRuntimeService
let host: typeof HostRuntime

beforeAll(async () => {
  host = await vi.importActual<typeof HostRuntime>('./structured-agent-session-runtime')
})

const location = () => ({
  stateDirectory,
  legacySessionTabIds: [],
  hostId: 'local',
  logger: createStructuredAgentSessionLogger()
})

beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'orca-pr-watch-runtime-'))
  vi.spyOn(profilePaths, 'getProfileUserDataPath').mockReturnValue(stateDirectory)
  runtime = new OrcaRuntimeService()
})

afterEach(async () => {
  vi.useRealTimers()
  watches.stopPRWatchRuntime()
  await retireAgentSessionRecordStore((opened) =>
    closeAgentSessionRecordStoreDatabase(opened?.journalDatabase)
  )
  recordStructuredAgentSessionHostInstallRefusal(null)
  vi.restoreAllMocks()
  await rm(stateDirectory, { recursive: true, force: true })
})

// Watch admission is process-wide and one-way, so the before-admission case runs first.
it('leaves the first watch start to the serving milestone, not the startup warmup', async () => {
  const drained = vi.spyOn(PRWatchService.prototype, 'start')
  await openTestAgentSessionRecordStoreSlot(location())

  // Serve's warmup timer can fire while its post-RPC prerequisites are still pending.
  runtime.noteAgentLaunchStartupSettled()
  await new Promise((resolve) => setImmediate(resolve))
  expect(drained).not.toHaveBeenCalled()

  runtime.startPullRequestWatches({ admit: true })
  await vi.waitFor(() => expect(drained).toHaveBeenCalledTimes(1))
})

it('starts CI-line watches when a chat installs after the serving milestone start failed', async () => {
  const drained = vi.spyOn(PRWatchService.prototype, 'start')
  const deps = { ...location(), resolveWorkspace: async () => null }

  // The serving milestone's first start fails to open the journal.
  await writeFile(journalDomainDatabasePath(stateDirectory), 'not a database')
  runtime.startPullRequestWatches({ admit: true })
  await watches.startPRWatchRuntime(deps)
  expect(drained).not.toHaveBeenCalled()

  // Storage recovers and a chat installs, with no teardown; installation retries the watch start.
  await rm(journalDomainDatabasePath(stateDirectory))
  await openTestAgentSessionRecordStoreSlot(location())
  await runtime.ensureStructuredAgentSessionHost()
  await vi.waitFor(() => expect(drained).toHaveBeenCalledTimes(1))
})

it('keeps one PR outcome observer when a partly started watch service fails and is retried', async () => {
  let observers = 0
  const addObserver = refresh.addPRRefreshOutcomeObserver
  vi.spyOn(refresh, 'addPRRefreshOutcomeObserver').mockImplementation((observer) => {
    const unsubscribe = addObserver(observer)
    observers += 1
    return () => {
      observers -= 1
      return unsubscribe()
    }
  })
  const read = JournalSqlReaderPool.prototype.database
  let failed = false
  vi.spyOn(JournalSqlReaderPool.prototype, 'database').mockImplementation(function (
    this: InstanceType<typeof JournalSqlReaderPool>,
    operation
  ) {
    if (!failed && operation.kind === 'pr-watch' && operation.operation.kind === 'watch-chats') {
      failed = true
      return Promise.reject(new Error('watch read failed once'))
    }
    return read.call(this, operation)
  })
  await openTestAgentSessionRecordStoreSlot(location())
  const deps = { ...location(), resolveWorkspace: async () => null }

  await watches.startPRWatchRuntime(deps, { admit: true })
  expect(failed).toBe(true)
  expect(observers).toBe(0)

  await watches.startPRWatchRuntime(deps)
  expect(observers).toBe(1)
  watches.stopPRWatchRuntime()
  expect(observers).toBe(0)
})

/** The reviewer's input: the first `watch-chats` read fails once, after the service registered its observer. */
function failFirstWatchRead(): { failed: () => boolean } {
  const read = JournalSqlReaderPool.prototype.database
  let failed = false
  vi.spyOn(JournalSqlReaderPool.prototype, 'database').mockImplementation(function (
    this: InstanceType<typeof JournalSqlReaderPool>,
    operation
  ) {
    if (!failed && operation.kind === 'pr-watch' && operation.operation.kind === 'watch-chats') {
      failed = true
      return Promise.reject(new Error('watch read failed once'))
    }
    return read.call(this, operation)
  })
  return { failed: () => failed }
}

/** A saved-chat host's store, opened through the production location so its maintenance pass is wired. */
async function openInstalledHostStore() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await openTestAgentSessionRecordStoreSlot(localAgentSessionRecordStoreLocation([]))
  return { ...location(), resolveWorkspace: async () => null }
}

const MAINTENANCE_PASS_MS = 60_000

it('does not restart a running watch service on the maintenance pass', async () => {
  const started = vi.spyOn(PRWatchService.prototype, 'start')
  const deps = await openInstalledHostStore()

  await watches.startPRWatchRuntime(deps, { admit: true })
  await vi.advanceTimersByTimeAsync(MAINTENANCE_PASS_MS)

  expect(started).toHaveBeenCalledTimes(1)
})

it('retries a failed first watch start on the maintenance pass, with no chat install or restart', async () => {
  const started = vi.spyOn(PRWatchService.prototype, 'start')
  const watchRead = failFirstWatchRead()
  const deps = await openInstalledHostStore()

  await watches.startPRWatchRuntime(deps, { admit: true })
  expect(watchRead.failed()).toBe(true)
  await vi.advanceTimersByTimeAsync(MAINTENANCE_PASS_MS)

  await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(2))
  await expect(started.mock.results[1]?.value).resolves.toBeUndefined()
})

it('retries a failed first watch start on the maintenance pass when the chat host opened the store', async () => {
  const started = vi.spyOn(PRWatchService.prototype, 'start')
  const watchRead = failFirstWatchRead()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  // Only the worker bundle differs from production; the host install's own location wins the slot.
  const open = JournalSqlDatabase.open
  const opened = vi.spyOn(JournalSqlDatabase, 'open').mockImplementation((directory, options) =>
    open.call(JournalSqlDatabase, directory, {
      ...options,
      writerPath: journalSqlWorkerPath(),
      readerPath: journalSqlReaderPath()
    })
  )
  try {
    await host.ensureStructuredAgentSessionHost({
      ...location(),
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => stateDirectory,
      resolveLaunchArgs: () => [],
      resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
      resolveEnvironment: async () => ({})
    })
    expect(opened).toHaveBeenCalledTimes(1)

    await watches.startPRWatchRuntime(
      { ...location(), resolveWorkspace: async () => null },
      { admit: true }
    )
    expect(watchRead.failed()).toBe(true)
    await vi.advanceTimersByTimeAsync(MAINTENANCE_PASS_MS)

    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(2))
    await expect(started.mock.results[1]?.value).resolves.toBeUndefined()
  } finally {
    await host.stopStructuredAgentSessionRuntime()
  }
})

// Committed shutdown is process-wide and sticky, so this runs last.
it('does not retry a failed watch start on the maintenance pass after shutdown committed', async () => {
  const started = vi.spyOn(PRWatchService.prototype, 'start')
  failFirstWatchRead()
  const deps = await openInstalledHostStore()

  await watches.startPRWatchRuntime(deps, { admit: true })
  markHostShuttingDown()
  await vi.advanceTimersByTimeAsync(MAINTENANCE_PASS_MS)

  expect(started).toHaveBeenCalledTimes(1)
})
