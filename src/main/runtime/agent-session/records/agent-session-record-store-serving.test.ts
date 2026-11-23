// @orca-isolated-worker -- Suite hooks own the temporary SQL worker bundle.
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  journalSqlReaderPath,
  journalSqlWorkerPath
} from '../../../native-chat/agent-session-journal/journal-sql-worker-bundle.test-fixture'
import { initializeJournalDomainDatabase } from '../../../native-chat/agent-session-journal/database/journal-domain-database'
import { journalDatabasePath } from '../../../native-chat/agent-session-journal/database/journal-host-database'
import { openJournalDatabase } from '../../../native-chat/agent-session-journal/database/journal-database'
import { acquireOrcadInstanceLock } from '../../../orcad/instance-lock/orcad-instance-lock'
import {
  setLegacyJournalRetirementHost,
  type LegacyJournalRetirementEvent
} from '../../../native-chat/agent-session-journal/journal-legacy-retirement-outcome'
import { retireAgentSessionRecordStore } from './agent-session-record-store-slot'
import * as startupOpen from './local-agent-session-record-store-startup-open'
import { chatJournalHostServing } from '../../../startup/runtime-startup/chat-journal-startup'
import { mainProcessState } from '../../../startup/main-process-state'
import { startOrcadAgentSessionRecordStoreOpen } from '../../../orcad/host-lifecycle/orcad-lifecycle'
import { markHostShuttingDown } from '../../../startup/quit/host-shutdown-state'
import { OrcaRuntimeWithGetWorktreePs } from '../../workspaces/process-listing/workspace-process-listing'

const profile = vi.hoisted(() => ({ directory: '' }))
vi.mock('../../../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => profile.directory
}))

vi.mock('../../rpc/methods/host-management/managed-runtime-install', () => ({
  reclaimManagedRuntimeReleasesAtLaunch: () => {},
  startManagedRuntimeAutoUpdates: () => {}
}))

afterEach(async () => {
  mainProcessState.core.runtime = null
  await retireAgentSessionRecordStore(async (opened) => opened?.journalDatabase.close())
  setLegacyJournalRetirementHost(undefined)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it('reaches old-history retirement at serving on empty profiles through both hosts, unless shutting down', async () => {
  vi.stubEnv('ORCA_APP_VERSION', '1.0.1')
  vi.stubEnv('ORCA_BACKGROUND_LAUNCH', '1')
  vi.stubEnv('ORCA_JOURNAL_NATIVE_LOCK_TEST', '0')
  const location = startupOpen.localAgentSessionRecordStoreLocation
  vi.spyOn(startupOpen, 'localAgentSessionRecordStoreLocation').mockImplementation((ids) => ({
    ...location(ids),
    writerPath: journalSqlWorkerPath(),
    readerPath: journalSqlReaderPath()
  }))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const runtime = {
    legacyStructuredSessionTabIds: [],
    openAgentSessionRecordStore: OrcaRuntimeWithGetWorktreePs.prototype.openAgentSessionRecordStore,
    startPullRequestWatches: () => {}
  }

  Object.assign(mainProcessState.core, { runtime })
  const hosts = [
    async () => chatJournalHostServing(),
    async () => {
      const handle = await startOrcadAgentSessionRecordStoreOpen(null)
      handle.serving(runtime)
    }
  ]
  const withProfile = async (run: (filename: string) => Promise<void>) => {
    const root = mkdtempSync(join(tmpdir(), 'orca-old-history-serving-'))
    profile.directory = root
    const lock = acquireOrcadInstanceLock(root, {
      machineIdentity: () => 'temporary-test-machine',
      startedAtMs: () => null,
      incarnation: () => null
    })
    try {
      await run(journalDatabasePath(root))
    } finally {
      await retireAgentSessionRecordStore(async (opened) => opened?.journalDatabase.close())
      lock.release()
      rmSync(root, { recursive: true, force: true })
    }
  }
  for (const serve of hosts) {
    await withProfile(async (filename) => {
      await initializeJournalDomainDatabase(profile.directory)
      const events: LegacyJournalRetirementEvent[] = []
      setLegacyJournalRetirementHost({ report: async (event) => events.push(event) > 0 })
      await serve()
      await vi.waitFor(() => expect(events).toHaveLength(1), { timeout: 10_000 })
      expect(events).toMatchObject([{ outcome: 'absent', defer: 'none' }])
      expect(existsSync(filename)).toBe(false)
    })
  }
  await withProfile(async (filename) => {
    openJournalDatabase(filename).db.close()
    await initializeJournalDomainDatabase(profile.directory)
    const events: LegacyJournalRetirementEvent[] = []
    setLegacyJournalRetirementHost({ report: async (event) => events.push(event) > 0 })
    chatJournalHostServing()
    await vi.waitFor(() => expect(events).toHaveLength(1), { timeout: 10_000 })
    expect(events).toMatchObject([{ outcome: 'deferred', defer: 'same_version' }])
    expect(existsSync(filename)).toBe(true)
  })

  const shutdownRoot = mkdtempSync(join(tmpdir(), 'orca-old-history-shutdown-'))
  profile.directory = shutdownRoot
  try {
    markHostShuttingDown()
    for (const serve of hosts) {
      await serve()
    }
    let openedOnShutdown = false
    await retireAgentSessionRecordStore(async (opened) => {
      openedOnShutdown = opened !== null
      await opened?.journalDatabase.close()
    })
    expect(openedOnShutdown).toBe(false)
    expect(existsSync(journalDatabasePath(shutdownRoot))).toBe(false)
  } finally {
    rmSync(shutdownRoot, { recursive: true, force: true })
  }
})
