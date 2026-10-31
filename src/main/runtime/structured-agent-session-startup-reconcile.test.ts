// Newer records reconcile read-only in memory; bookkeeping write failures must not put startup into Session restore failed.

import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { journalDatabasePath } from '../native-chat/agent-session-journal/journal-host-database'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type * as AgentSessionRecordRows from './agent-session-record-rows'
import {
  seedTestAgentSessionRecordStore,
  seedTestAgentSessionStoreFromNewerBuild
} from './agent-session-record-store-test-harness'
import { closeTestJournalHostDatabases } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { OrcaRuntimeService } from './orca-runtime'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import { recordingStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'

const writes = vi.hoisted(() => ({ failing: false }))

vi.mock('./agent-session-record-rows', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentSessionRecordRows>()
  return {
    ...actual,
    writeAgentSessionStoreRows: (...args: Parameters<typeof actual.writeAgentSessionStoreRows>) => {
      if (writes.failing) {
        throw new Error('disk I/O error')
      }
      return actual.writeAgentSessionStoreRows(...args)
    }
  }
})

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-startup-reconcile-'))
})

afterEach(async () => {
  writes.failing = false
  await stopStructuredAgentSessionRuntime().catch(() => undefined)
  await closeTestJournalHostDatabases()
  vi.restoreAllMocks()
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
  return { path: journalDatabasePath(root), sessionId: record.sessionId }
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

it('finishes startup when the reconcile cannot write, and reports it', async () => {
  const { sessionId } = await seedChat()
  const log = recordingStructuredAgentSessionLogger()
  const runtime = startupRuntime(log)
  writes.failing = true

  await expect(runtime.prepareStructuredAgentSessionStartupRestoration()).resolves.toBeUndefined()

  expect(log.entries).toEqual([
    expect.objectContaining({
      fields: {
        scope: 'lease-reconcile',
        error: expect.objectContaining({ message: 'disk I/O error' })
      }
    })
  ])
  expect(getStructuredAgentSessionHost()?.sessionAgent(sessionId)).toBe('claude')
})
