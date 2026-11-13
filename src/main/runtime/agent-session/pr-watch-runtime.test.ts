import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as profilePaths from '../../orca-profiles/profile-storage-paths'
import { PRWatchService } from '../../github/pr-watch/pr-watch-service'
import * as refresh from '../../github/pull-requests/refresh/pr-refresh-coordinator'
import { JournalSqlReaderPool } from '../../native-chat/agent-session-journal/journal-sql-reader-pool'
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
import type * as HostRuntime from './structured-agent-session-runtime'

// The chat host's own installation is covered elsewhere; this exercises what installation does next.
vi.mock('./structured-agent-session-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof HostRuntime>()),
  ensureStructuredAgentSessionHost: vi.fn(async () => undefined)
}))

let stateDirectory: string
let runtime: OrcaRuntimeService

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
