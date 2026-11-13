// Newer records reconcile read-only in memory.

import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { agentSessionRecordFixture } from '../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { journalDomainDatabasePath } from '../../native-chat/agent-session-journal/database/journal-domain-database'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  ensureTestStructuredAgentSessionHost as ensureStructuredAgentSessionHost,
  openTestAgentSessionRecordStoreSlot,
  seedTestAgentSessionRecordStore,
  seedTestAgentSessionStoreFromNewerBuild
} from './records/agent-session-record-store-test-harness'
import { closeTestJournalHostDatabases } from '../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { OrcaRuntimeService } from '../orca-runtime'
import { stopStructuredAgentSessionRuntime } from './structured-agent-session-runtime'
import {
  recordStructuredAgentSessionHostInstallRefusal,
  structuredAgentSessionHostRefusal
} from './structured-agent-session-host-refusal'
import { recordingStructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-logger.test-fixture'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-startup-reconcile-'))
})

afterEach(async () => {
  recordStructuredAgentSessionHostInstallRefusal(null)
  await stopStructuredAgentSessionRuntime().catch(() => undefined)
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

/** A profile with one chat whose last owner is gone; `newer` stamps it as a newer Orca's. */
async function seedChat(options: { newer?: boolean } = {}) {
  const record = agentSessionRecordFixture()
  await seedTestAgentSessionRecordStore(root, { records: [record] })
  if (options.newer) {
    await seedTestAgentSessionStoreFromNewerBuild(root)
  }
  await closeTestJournalHostDatabases()
  return { path: journalDomainDatabasePath(root), sessionId: record.sessionId }
}

function startupRuntime(log = recordingStructuredAgentSessionLogger()) {
  const runtime = new OrcaRuntimeService()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are the runtime's own protected members; the test roots the host at `root` and stubs the PTY daemon.
  const internal = runtime as unknown as {
    hasPersistedStructuredAgentSessionStore(): boolean
    ensureStructuredAgentSessionHost(): Promise<unknown>
    refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
  }
  internal.hasPersistedStructuredAgentSessionStore = () => true
  internal.ensureStructuredAgentSessionHost = () =>
    ensureStructuredAgentSessionHost({
      logger: log.logger,
      stateDirectory: root,
      hostId: 'local',
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => root,
      resolveEnvironment: async () => ({}),
      resolveLaunchArgs: () => [],
      resolveClaudeAuthPolicy: () => ({ account: 'managed' })
    })
  internal.refreshMobileSessionPtyRecords = async () => new Set<string>()
  return runtime
}

it('finishes startup over records a newer Orca wrote, reads them, and writes nothing', async () => {
  const { path, sessionId } = await seedChat({ newer: true })
  const bytes = await readFile(path)
  const log = recordingStructuredAgentSessionLogger()
  const runtime = startupRuntime(log)

  await expect(runtime.prepareStructuredAgentSessionStartupRestoration()).resolves.toBeUndefined()

  expect(log.entries).toEqual([])
  const host = getStructuredAgentSessionHost()
  expect(host?.sessionAgent(sessionId)).toBe('claude')
  // Adjudicated in memory only: the verdict is re-derived at the next start.
  expect(host?.deps.store.getRecord(sessionId)?.lease.unreconciled).toBe(false)
  await stopStructuredAgentSessionRuntime()
  expect(await readFile(path)).toEqual(bytes)
})

it('does not boot the journal writer again before RPC after this startup refused it', async () => {
  await writeFile(journalDomainDatabasePath(root), 'not a database')
  const opened = openTestAgentSessionRecordStoreSlot({
    stateDirectory: root,
    legacySessionTabIds: [],
    hostId: 'local',
    logger: recordingStructuredAgentSessionLogger().logger
  })
  opened.catch(() => {})
  const runtime = startupRuntime()
  let installs = 0
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime's own protected install, counted to prove the refusal is not reopened.
  const internal = runtime as unknown as { ensureStructuredAgentSessionHost(): Promise<unknown> }
  internal.ensureStructuredAgentSessionHost = async () => {
    installs += 1
  }
  runtime.beginStructuredAgentSessionStartupOpen({ persisted: true, opened })

  await expect(runtime.prepareStructuredAgentSessionStartupRestoration()).resolves.toBeUndefined()

  expect(structuredAgentSessionHostRefusal()).not.toBeNull()
  expect(installs).toBe(0)
})
