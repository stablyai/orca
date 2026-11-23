// @orca-isolated-worker -- Suite hooks own the temporary SQL worker bundle.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  journalSqlReaderPath,
  journalSqlWorkerPath
} from '../../../native-chat/agent-session-journal/journal-sql-worker-bundle.test-fixture'
import {
  initializeJournalDomainDatabase,
  openJournalDomainDatabase
} from '../../../native-chat/agent-session-journal/database/journal-domain-database'
import {
  JOURNAL_LEGACY_CONVERTED_BY,
  journalDatabasePath
} from '../../../native-chat/agent-session-journal/database/journal-host-database'
import { openJournalDatabase } from '../../../native-chat/agent-session-journal/database/journal-database'
import { acquireOrcadInstanceLock } from '../../../orcad/instance-lock/orcad-instance-lock'
import { ownsOrcadProfileDirectory } from '../../../orcad/instance-lock/orcad-instance-lock-hold'
import {
  setLegacyJournalRetirementHost,
  type LegacyJournalRetirementEvent
} from '../../../native-chat/agent-session-journal/journal-legacy-retirement-outcome'
import {
  hasPersistedStructuredAgentSessionStore,
  peekOpenedAgentSessionRecordStore,
  retireAgentSessionRecordStore
} from './agent-session-record-store-slot'
import * as startupOpen from './local-agent-session-record-store-startup-open'
import { agentSessionRecordStoreHostServing } from './agent-session-record-store-serving'
import { markHostShuttingDown } from '../../../startup/quit/host-shutdown-state'
import { OrcaRuntimeWithGetWorktreePs } from '../../workspaces/process-listing/workspace-process-listing'

const profile = vi.hoisted(() => ({ directory: '' }))
vi.mock('../../../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => profile.directory
}))

afterEach(async () => {
  await retireAgentSessionRecordStore(async (opened) => opened?.journalDatabase.close())
  setLegacyJournalRetirementHost(undefined)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it('reaches old-history retirement at serving on empty profiles through both hosts, unless shutting down', async () => {
  for (const [host, argument] of [
    ['src/main/startup/runtime-startup/chat-journal-startup.ts', 'state.core.runtime'],
    ['src/main/backend/core-runtime-activation.ts', 'runtime']
  ] as const) {
    expect(readFileSync(host, 'utf8')).toContain(`agentSessionRecordStoreHostServing(${argument})`)
  }
  vi.stubEnv('ORCA_APP_VERSION', '1.0.1')
  vi.stubEnv('ORCA_BACKGROUND_LAUNCH', '1')
  vi.stubEnv('ORCA_JOURNAL_NATIVE_LOCK_TEST', '0')
  const location = startupOpen.localAgentSessionRecordStoreLocation
  vi.spyOn(startupOpen, 'localAgentSessionRecordStoreLocation').mockImplementation((ids) => ({
    ...location(ids),
    writerPath: journalSqlWorkerPath(),
    readerPath: journalSqlReaderPath()
  }))
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const runtime = {
    legacyStructuredSessionTabIds: [],
    openAgentSessionRecordStore: OrcaRuntimeWithGetWorktreePs.prototype.openAgentSessionRecordStore,
    startPullRequestWatches: () => {}
  }

  for (const present of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), 'orca-old-history-serving-'))
    profile.directory = root
    const lock = acquireOrcadInstanceLock(root, {
      machineIdentity: () => 'temporary-test-machine',
      startedAtMs: () => null,
      incarnation: () => null
    })
    try {
      expect(ownsOrcadProfileDirectory(root)).toBe(true)
      const filename = journalDatabasePath(root)
      if (present) {
        openJournalDatabase(filename).db.close()
      }
      const domainFile = await initializeJournalDomainDatabase(root)
      const { db } = openJournalDomainDatabase(domainFile)
      try {
        expect(
          db
            .prepare('SELECT value FROM agent_session_store_meta WHERE key = ?')
            .get(JOURNAL_LEGACY_CONVERTED_BY)?.value
        ).toBe('1.0.1')
      } finally {
        db.close()
      }
      expect(hasPersistedStructuredAgentSessionStore(root)).toBe(false)
      expect(peekOpenedAgentSessionRecordStore()).toBeNull()
      const events: LegacyJournalRetirementEvent[] = []
      setLegacyJournalRetirementHost({ report: async (event) => events.push(event) > 0 })
      agentSessionRecordStoreHostServing(runtime)
      await vi.waitFor(() => expect(events).toHaveLength(1), { timeout: 10_000 })
      expect(events).toMatchObject([
        { outcome: present ? 'deferred' : 'absent', defer: present ? 'same_version' : 'none' }
      ])
      expect(log.mock.calls.flat().some((line) => String(line).includes('old chat journal:'))).toBe(
        true
      )
      expect(existsSync(filename)).toBe(present)
    } finally {
      await retireAgentSessionRecordStore(async (opened) => opened?.journalDatabase.close())
      lock.release()
      rmSync(root, { recursive: true, force: true })
    }
  }

  const shutdownRoot = mkdtempSync(join(tmpdir(), 'orca-old-history-shutdown-'))
  profile.directory = shutdownRoot
  try {
    markHostShuttingDown()
    agentSessionRecordStoreHostServing(runtime)
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
