import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as profilePaths from '../../orca-profiles/profile-storage-paths'
import { PRWatchService } from '../../github/pr-watch/pr-watch-service'
import { journalDomainDatabasePath } from '../../native-chat/agent-session-journal/database/journal-domain-database'
import { createStructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { openTestAgentSessionRecordStoreSlot } from './records/agent-session-record-store-test-harness'
import {
  closeAgentSessionRecordStoreDatabase,
  retireAgentSessionRecordStore
} from './records/agent-session-record-store-slot'
import { startPRWatchRuntime, stopPRWatchRuntime } from './pr-watch-runtime'
import { recordStructuredAgentSessionHostInstallRefusal } from './structured-agent-session-host-refusal'
import { OrcaRuntimeService } from '../orca-runtime'
import type * as HostRuntime from './structured-agent-session-runtime'

// The chat host's own installation is covered elsewhere; this exercises what installation does next.
vi.mock('./structured-agent-session-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof HostRuntime>()),
  ensureStructuredAgentSessionHost: vi.fn(async () => undefined)
}))

let stateDirectory: string

const location = () => ({
  stateDirectory,
  legacySessionTabIds: [],
  hostId: 'local',
  logger: createStructuredAgentSessionLogger()
})

beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'orca-pr-watch-runtime-'))
})

afterEach(async () => {
  stopPRWatchRuntime()
  await retireAgentSessionRecordStore((opened) =>
    closeAgentSessionRecordStoreDatabase(opened?.journalDatabase)
  )
  recordStructuredAgentSessionHostInstallRefusal(null)
  vi.restoreAllMocks()
  await rm(stateDirectory, { recursive: true, force: true })
})

it('starts CI-line watches when a chat installs after the serving milestone start failed', async () => {
  vi.spyOn(profilePaths, 'getProfileUserDataPath').mockReturnValue(stateDirectory)
  const drained = vi.spyOn(PRWatchService.prototype, 'start')
  const runtime = new OrcaRuntimeService()
  const deps = { ...location(), resolveWorkspace: async () => null }

  // The serving milestone's first start fails to open the journal.
  await writeFile(journalDomainDatabasePath(stateDirectory), 'not a database')
  runtime.startPullRequestWatches({ admit: true })
  await startPRWatchRuntime(deps)
  expect(drained).not.toHaveBeenCalled()

  // Storage recovers and a chat installs, with no teardown; installation retries the watch start.
  await rm(journalDomainDatabasePath(stateDirectory))
  await openTestAgentSessionRecordStoreSlot(location())
  await runtime.ensureStructuredAgentSessionHost()
  await vi.waitFor(() => expect(drained).toHaveBeenCalledTimes(1))
})
