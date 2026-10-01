// The records file's one-time copy never keeps the host from installing. A file no read will make
// usable is reported and left alone; a read that can clear leaves the copy owed, and until a later
// launch makes it, the chat list says it cannot tell rather than "none".

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import Database from '../sqlite/sync-database'
import { journalPragmaNumber } from '../native-chat/agent-session-journal/journal-database'
import { journalDatabasePath } from '../native-chat/agent-session-journal/journal-host-database'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { legacyAgentSessionStorePath } from './agent-session-record-store-file'
import { OrcaRuntimeService } from './orca-runtime'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

const NOW = 1_800_000_000_000
const IMPORTED = 'session-alpha-1'
const CREATED_WHILE_OWED = 'session-new-0001'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-record-import-install-'))
})

afterEach(async () => {
  await stopStructuredAgentSessionRuntime().catch(() => undefined)
  vi.restoreAllMocks()
  await chmod(legacyAgentSessionStorePath(root), 0o600).catch(() => undefined)
  await rm(root, { recursive: true, force: true })
})

async function writeLegacy(contents: string): Promise<void> {
  await mkdir(dirname(legacyAgentSessionStorePath(root)), { recursive: true })
  await writeFile(legacyAgentSessionStorePath(root), contents)
}

const legacyFile = (): string =>
  JSON.stringify({
    schemaVersion: 2,
    hostId: 'local',
    records: { [IMPORTED]: agentSessionRecordFixture() },
    operations: {},
    retiredClaimKeys: [],
    unusableRecords: {}
  })

function databaseVersion(): number {
  const db = new Database(journalDatabasePath(root))
  try {
    return journalPragmaNumber(db, 'user_version')
  } finally {
    db.close()
  }
}

/** The runtime at startup, rooted at `root`, with its PTY daemon stubbed. */
function startupRuntime(onError: (input: { scope: string; error: unknown }) => void) {
  const runtime = new OrcaRuntimeService()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are the runtime's own protected members; the test roots the host at `root` and stubs the PTY daemon.
  const internal = runtime as unknown as {
    hasPersistedStructuredAgentSessionStore(): boolean
    ensureStructuredAgentSessionHost(): Promise<StructuredAgentSessionHost>
    refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
    structuredAgentSessionInventoryUnverifiable: boolean
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
      onError
    })
  internal.refreshMobileSessionPtyRecords = async () => new Set<string>()
  return {
    runtime,
    host: () => internal.ensureStructuredAgentSessionHost(),
    unverifiable: () => internal.structuredAgentSessionInventoryUnverifiable
  }
}

function importReports(onError: ReturnType<typeof vi.fn>): unknown[] {
  return onError.mock.calls
    .map(([input]) => input)
    .filter((input) => input.scope === 'structured-agent-session-record-import')
    .map((input) => input.error)
}

// A read that can clear: the file's own permissions, as a locked-down or mid-restore profile has.
it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'installs while the file cannot be read, says it cannot tell, and copies it once it can',
  async () => {
    await writeLegacy(legacyFile())
    await chmod(legacyAgentSessionStorePath(root), 0o000)
    const onError = vi.fn()
    const first = startupRuntime(onError)

    await first.runtime.restoreStructuredAgentSessionTabs()
    const host = await first.host()

    expect(importReports(onError)).toEqual([
      {
        kind: 'unavailable',
        error: expect.objectContaining({ message: 'agent_session_store_corrupt' })
      }
    ])
    expect(host.legacyRecordImportOwed()).toBe(true)
    expect(first.unverifiable()).toBe(true)
    expect(databaseVersion()).toBe(3)
    // A chat started meanwhile lives in the database and keeps its row through the copy.
    await host.deps.store.reserveOwner({
      sessionId: CREATED_WHILE_OWED,
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'folder'
      },
      provider: 'claude',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude' },
      expectedFence: null,
      spawnToken: 'spawn-new',
      claimKeyId: 'key-1',
      handoffOperationId: null,
      probe: { outcome: 'reservation-unused' },
      operation: {
        callerKey: 'client-1',
        operationId: `${NOW}-${'0'.repeat(31)}1`,
        fingerprint: 'fp-new'
      },
      now: NOW
    })
    await stopStructuredAgentSessionRuntime()

    await chmod(legacyAgentSessionStorePath(root), 0o600)
    const second = startupRuntime(vi.fn())
    await second.runtime.restoreStructuredAgentSessionTabs()
    const relaunched = await second.host()

    expect(relaunched.legacyRecordImportOwed()).toBe(false)
    expect(second.unverifiable()).toBe(false)
    expect(databaseVersion()).toBe(4)
    expect(relaunched.deps.store.getRecord(IMPORTED)).not.toBeNull()
    expect(relaunched.deps.store.getRecord(CREATED_WHILE_OWED)).not.toBeNull()
  }
)

it('installs over a file no read will make usable, reports it once, and leaves it untouched', async () => {
  await writeLegacy('{ truncated')
  const onError = vi.fn()
  const { runtime, host } = startupRuntime(onError)

  await expect(runtime.prepareStructuredAgentSessionStartupRestoration()).resolves.toBeUndefined()

  expect(importReports(onError)).toEqual([
    { kind: 'unusable', error: expect.objectContaining({ message: 'agent_session_store_corrupt' }) }
  ])
  expect((await host()).legacyRecordImportOwed()).toBe(false)
  expect(databaseVersion()).toBe(4)
  await stopStructuredAgentSessionRuntime()
  expect(await readFile(legacyAgentSessionStorePath(root), 'utf-8')).toBe('{ truncated')
})
