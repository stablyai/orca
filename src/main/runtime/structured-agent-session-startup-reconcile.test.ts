// A profile whose chat records a newer Orca wrote opens read-only. The startup reconcile adjudicates
// its leases in memory and writes nothing there; a reconcile whose write fails is bookkeeping too.
// Either way startup must finish rather than put the whole app into its degraded "Session restore
// failed" mode.

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
  closeTestJournalHostDatabases()
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
  closeTestJournalHostDatabases()
  return { path: journalDatabasePath(root), sessionId: record.sessionId }
}

function startupRuntime(onError?: (input: { scope: string; error: unknown }) => void) {
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
      stateDirectory: root,
      hostId: 'local',
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => root,
      resolveEnvironment: async () => ({}),
      resolveClaudeAuthPolicy: () => ({ stripAuthEnv: true }),
      ...(onError ? { onError } : {})
    })
  internal.refreshMobileSessionPtyRecords = async () => new Set<string>()
  return runtime
}

it('finishes startup over records a newer Orca wrote, reads them, and writes nothing', async () => {
  const { path, sessionId } = await seedChat({ newer: true })
  const bytes = await readFile(path)
  const onError = vi.fn()
  const runtime = startupRuntime(onError)

  // What the renderer's startup awaits through `app:prepareTerminalStartupRestoration`.
  await expect(runtime.prepareStructuredAgentSessionStartupRestoration()).resolves.toBeUndefined()

  expect(onError).not.toHaveBeenCalled()
  const host = getStructuredAgentSessionHost()
  expect(host?.sessionAgent(sessionId)).toBe('claude')
  // Adjudicated in memory only: the verdict is re-derived at the next start.
  expect(host?.deps.store.getRecord(sessionId)?.lease.unreconciled).toBe(false)
  await stopStructuredAgentSessionRuntime()
  expect(await readFile(path)).toEqual(bytes)
})

it('finishes startup when the reconcile cannot write, and reports it', async () => {
  const { sessionId } = await seedChat()
  const onError = vi.fn()
  const runtime = startupRuntime(onError)
  writes.failing = true

  await expect(runtime.prepareStructuredAgentSessionStartupRestoration()).resolves.toBeUndefined()

  expect(onError).toHaveBeenCalledOnce()
  expect(onError).toHaveBeenCalledWith({
    scope: 'structured-agent-session-lease-reconcile',
    error: expect.objectContaining({ message: 'disk I/O error' })
  })
  expect(getStructuredAgentSessionHost()?.sessionAgent(sessionId)).toBe('claude')
})

// The desktop installs its host with no error sink, so the failure is logged rather than dropped.
it('logs the failure when the host has no error sink', async () => {
  await seedChat()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  writes.failing = true

  await expect(
    startupRuntime().prepareStructuredAgentSessionStartupRestoration()
  ).resolves.toBeUndefined()

  expect(warn).toHaveBeenCalledWith(
    '[structured-agent-session] reconciling chat leases failed',
    expect.objectContaining({ message: 'disk I/O error' })
  )
})

// Closing a chat tab drops it from the restore index, which a newer Orca's records refuse: the
// close is reported and goes on, since bookkeeping never keeps a tab open.
it('closes a chat tab over records a newer Orca wrote, reporting the index it cannot write', async () => {
  const { sessionId } = await seedChat({ newer: true })
  const runtime = startupRuntime(vi.fn())
  await runtime.prepareStructuredAgentSessionStartupRestoration()
  const host = getStructuredAgentSessionHost()
  const close = vi.spyOn(host!, 'close')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime's own protected close path, reached with the one field it reads.
  const internal = runtime as unknown as {
    closeStructuredAgentSessionTab(tab: { sessionId: string }, cause: 'user-close'): Promise<void>
  }

  await expect(
    internal.closeStructuredAgentSessionTab({ sessionId }, 'user-close')
  ).resolves.toBeUndefined()

  expect(warn).toHaveBeenCalledWith(
    '[structured-agent-session] recording a closed chat tab failed',
    expect.objectContaining({
      refusal: expect.objectContaining({ details: { reason: 'journalWrittenByNewerOrca' } })
    })
  )
  expect(close).toHaveBeenCalledWith(sessionId, 'user-close')
})
