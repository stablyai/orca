import { structuredAgentSessionTabId } from '../../shared/structured-agent-session-projection'
import { seedTestAgentSessionRecordStore } from './agent-session-record-store-test-harness'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
// Journal-open refusal leaves the file intact and other runtime work available.

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isAgentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import { JOURNAL_DB_SCHEMA_VERSION } from '../native-chat/agent-session-journal/journal-database-schema'
import {
  JournalHostDatabase,
  journalDatabasePath
} from '../native-chat/agent-session-journal/journal-host-database'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import Database from '../sqlite/sync-database'
import type { RuntimeNavigationTarget } from '../../shared/runtime-navigation'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import { OrcaRuntimeService } from './orca-runtime'
import { requireStructuredHost } from './rpc/methods/structured-agent-session-gate'
import { assertLegacyAiVaultResumeCommandAllowed } from '../ai-vault/structured-session-ownership'
import type { RpcContext } from './rpc/core'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import { recordingStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'

let root: string
let log = recordingStructuredAgentSessionLogger()
const openFailureLogs = () =>
  log.entries.filter((entry) => entry.fields.scope === 'journal-database-open')

// An in-process caller: the same build as the host, so the gate asks it for no capability.
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the gate reads only `clientKind` and `clientCapabilities`.
const IN_PROCESS = {} as RpcContext

function install(): ReturnType<typeof ensureStructuredAgentSessionHost> {
  return ensureStructuredAgentSessionHost({
    logger: log.logger,
    stateDirectory: root,
    hostId: 'local',
    claimKeyId: 'key-1',
    resolveWorkspacePath: async () => root,
    resolveEnvironment: async () => ({}),
    resolveLaunchArgs: () => [],
    resolveClaudeAuthPolicy: () => ({ account: 'managed' })
  })
}

/** The refusal as the gate throws it for every structured request. */
function gateRefusal(): { reason: unknown; message: string } {
  try {
    requireStructuredHost(IN_PROCESS)
  } catch (error) {
    if (isAgentSessionRefusalError(error)) {
      return { reason: error.refusal.details?.reason, message: error.refusal.message }
    }
    throw error
  }
  throw new Error('the gate admitted the request')
}

async function digest(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-host-refusal-'))
  log = recordingStructuredAgentSessionLogger()
})

afterEach(async () => {
  await stopStructuredAgentSessionRuntime().catch(() => undefined)
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe('a process whose journal will not open', () => {
  it('refuses every chat and leaves a damaged file exactly as it is', async () => {
    const path = journalDatabasePath(root)
    await writeFile(path, 'not a database '.repeat(512))
    const before = await digest(path)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(install()).rejects.toMatchObject({
      refusal: { message: 'Unable to load this chat.', details: { reason: 'journalCorrupt' } }
    })
    expect(gateRefusal()).toEqual({
      reason: 'journalCorrupt',
      message: 'Unable to load this chat.'
    })
    expect(await digest(path)).toBe(before)
    expect(existsSync(`${path}-wal`)).toBe(false)
    expect(existsSync(`${path}-shm`)).toBe(false)

    await unlink(path)
    await expect(install()).resolves.toBeDefined()
    expect(gateRefusal).toThrow('the gate admitted the request')
  })

  it('refuses a database an unreleased build wrote as unusable, and says to move it aside', async () => {
    const path = journalDatabasePath(root)
    const earlier = new Database(path)
    earlier.exec('CREATE TABLE journal_rows (id INTEGER PRIMARY KEY, row_json TEXT NOT NULL)')
    earlier.pragma('user_version = 2')
    earlier.close()
    const before = await digest(path)

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(install()).rejects.toMatchObject({
        refusal: { message: 'Unable to load this chat.', details: { reason: 'journalCorrupt' } }
      })
    }
    expect(gateRefusal()).toEqual({
      reason: 'journalCorrupt',
      message: 'Unable to load this chat.'
    })
    expect(openFailureLogs()).toHaveLength(1)
    const logged = String(openFailureLogs()[0]?.fields.error)
    expect(logged).toContain(path)
    expect(logged).toContain('unreleased development build')
    expect(logged).toContain('Moving the file aside')
    expect(await digest(path)).toBe(before)
  })

  it('installs over a database a newer Orca wrote, and leaves it byte-identical', async () => {
    const path = journalDatabasePath(root)
    const seeded = new Database(path)
    seeded.pragma(`user_version = ${JOURNAL_DB_SCHEMA_VERSION + 1}`)
    seeded.close()
    const before = await digest(path)

    await expect(install()).resolves.toBeDefined()
    expect(gateRefusal).toThrow('the gate admitted the request')
    await stopStructuredAgentSessionRuntime()
    expect(await digest(path)).toBe(before)
  })
})

describe('logging a journal that will not open', () => {
  async function writeJunkJournal(): Promise<void> {
    const path = journalDatabasePath(root)
    await rm(`${path}-wal`, { force: true })
    await rm(`${path}-shm`, { force: true })
    await writeFile(path, 'not a database '.repeat(512))
  }

  it('logs a repeated failure once, with its stack, and again after an open succeeds', async () => {
    await install()
    await stopStructuredAgentSessionRuntime()
    await writeJunkJournal()

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(install()).rejects.toMatchObject({
        refusal: { details: { reason: 'journalCorrupt' } }
      })
    }
    expect(openFailureLogs()).toHaveLength(1)
    expect(openFailureLogs()[0]?.fields.error).toBeInstanceOf(Error)
    expect(openFailureLogs()[0]?.fields.error).toHaveProperty(
      'stack',
      expect.stringContaining('\n')
    )

    await unlink(journalDatabasePath(root))
    await install()
    await stopStructuredAgentSessionRuntime()
    await writeJunkJournal()
    await expect(install()).rejects.toMatchObject({
      refusal: { details: { reason: 'journalCorrupt' } }
    })
    expect(openFailureLogs()).toHaveLength(2)
  })
})

describe('startup and other non-chat work without a structured host', () => {
  function startupRuntime(ensureHost: () => Promise<unknown> = install) {
    const runtime = new OrcaRuntimeService()
    const refreshPtyRecords = vi.fn(async () => new Set<string>())
    const hydrateTabs = vi.fn(() => new Set<string>())
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are the runtime's own protected members; the test roots the host at `root` and stubs the PTY daemon.
    const internal = runtime as unknown as {
      hasPersistedStructuredAgentSessionStore(): boolean
      ensureStructuredAgentSessionHost(): Promise<unknown>
      refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
      getKnownWorkspaceSessionWorktreeIds(): Set<string>
      hydrateHeadlessMobileSessionTabsFromWorkspaceSession(): Set<string>
    }
    internal.hasPersistedStructuredAgentSessionStore = () => true
    internal.ensureStructuredAgentSessionHost = ensureHost
    internal.refreshMobileSessionPtyRecords = refreshPtyRecords
    internal.getKnownWorkspaceSessionWorktreeIds = () => new Set(['workspace-1'])
    internal.hydrateHeadlessMobileSessionTabsFromWorkspaceSession = hydrateTabs
    return { runtime, refreshPtyRecords, hydrateTabs }
  }

  async function expectStartupWithoutHost(runtime: OrcaRuntimeService): Promise<void> {
    await expect(runtime.prepareStructuredAgentSessionStartupRestoration()).resolves.toBeUndefined()
    // What `session.tabs.list` awaits before it answers a paired client.
    await expect(runtime.restoreStructuredAgentSessionTabs()).resolves.toBeUndefined()
    expect(getStructuredAgentSessionHost()).toBeNull()
  }

  async function writeJunkJournal(): Promise<void> {
    await writeFile(journalDatabasePath(root), 'not a database '.repeat(512))
  }

  it('goes ahead when its journal will not open', async () => {
    await writeJunkJournal()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { runtime, refreshPtyRecords, hydrateTabs } = startupRuntime()

    await expectStartupWithoutHost(runtime)

    expect(refreshPtyRecords).toHaveBeenCalledOnce()
    expect(hydrateTabs).toHaveBeenCalledWith('workspace-1', {
      allowAttachedWindow: true,
      onlyRuntimeOwnedTerminals: true
    })
    expect(gateRefusal()).toEqual({
      reason: 'journalCorrupt',
      message: 'Unable to load this chat.'
    })
  })

  // An unverifiable inventory must be marked: clients cull omitted chats and persist the resulting tab list.
  describe('the session-tabs inventory', () => {
    /** The worktree's frame as the renderer's own graph publication leaves it: no chat rows. */
    const WORKTREE_FRAME: RuntimeMobileSessionTabsResult = {
      worktree: 'workspace-1',
      publicationEpoch: 'renderer-epoch',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    }

    function publishWorktreeFrame(runtime: OrcaRuntimeService): void {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime's own protected store, called as its graph publication does.
      const internal = runtime as unknown as {
        storeMobileSessionSnapshot(worktreeId: string, snapshot: unknown): unknown
      }
      internal.storeMobileSessionSnapshot('workspace-1', WORKTREE_FRAME)
    }

    async function listInventory(runtime: OrcaRuntimeService) {
      await runtime.restoreStructuredAgentSessionTabs()
      return runtime.listAllMobileSessionTabs()
    }

    it('marks chats unverifiable when its journal will not open', async () => {
      await writeJunkJournal()
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const { runtime } = startupRuntime()
      publishWorktreeFrame(runtime)

      const frames = await listInventory(runtime)

      expect(frames).toEqual([
        expect.objectContaining({ worktree: 'workspace-1', agentSessionsUnverifiable: true })
      ])
    })

    // A tap's reply goes straight back to the tapping client, not through the list.
    it.each<RuntimeNavigationTarget>(['caller', 'clients'])(
      'marks a %s navigation reply unverifiable while its journal will not open',
      async (navigation) => {
        await writeJunkJournal()
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const { runtime } = startupRuntime()
        publishWorktreeFrame(runtime)
        await listInventory(runtime)
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime's own protected navigation step, called as `session.tabs.activate` does.
        const internal = runtime as unknown as {
          applyMobileSessionTabNavigation(
            snapshot: RuntimeMobileSessionTabsResult,
            activeTabId: string,
            navigation: RuntimeNavigationTarget,
            clientNavigationId?: string
          ): RuntimeMobileSessionTabsResult
        }

        const reply = internal.applyMobileSessionTabNavigation(
          WORKTREE_FRAME,
          'agent-session:claude-1',
          navigation,
          'phone-1'
        )

        expect(reply).toMatchObject({ worktree: 'workspace-1', agentSessionsUnverifiable: true })
      }
    )

    it('lists no chats as a real answer once there is a host', async () => {
      const { runtime } = startupRuntime()
      publishWorktreeFrame(runtime)

      const frames = await listInventory(runtime)

      expect(frames).toHaveLength(1)
      expect(frames[0]).not.toHaveProperty('agentSessionsUnverifiable')
      expect(getStructuredAgentSessionHost()).not.toBeNull()
    })

    // Subscribers still hold unverifiable frames, so a successful restore must publish the recovered inventory.
    it('pushes the chats without the mark once a later list has a host', async () => {
      await writeJunkJournal()
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const { runtime } = startupRuntime()
      publishWorktreeFrame(runtime)
      expect((await listInventory(runtime))[0]).toMatchObject({ agentSessionsUnverifiable: true })
      const pushed: RuntimeMobileSessionTabsResult[] = []
      const unsubscribe = runtime.onMobileSessionTabsChanged((frame) => pushed.push(frame))

      await unlink(journalDatabasePath(root))
      await seedTestAgentSessionRecordStore(root, {
        records: [agentSessionRecordFixture({ sessionId: 'claude-1' })],
        sessionTabs: [{ tabId: structuredAgentSessionTabId('claude-1'), sessionId: 'claude-1' }]
      })
      const host = await install()
      expect(host.deps.store.getConversation('claude-1')).toMatchObject({ sessionId: 'claude-1' })
      expect(host.getPersistedVisibleSessionTabIndex()).toEqual({
        present: true,
        sessionIds: ['claude-1']
      })
      expect(host.isSessionTabVisible('claude-1')).toBe(true)
      const frames = await listInventory(runtime)
      unsubscribe()

      const chats = [expect.objectContaining({ type: 'agent-session', sessionId: 'claude-1' })]
      expect(frames).toEqual([expect.objectContaining({ tabs: chats })])
      expect(frames[0]).not.toHaveProperty('agentSessionsUnverifiable')
      expect(pushed.at(-1)?.tabs).toEqual(chats)
      expect(pushed.at(-1)).not.toHaveProperty('agentSessionsUnverifiable')
    })
  })

  it('lets a terminal resume command through while its journal will not open', async () => {
    await writeJunkJournal()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    // The check `terminal.send` and `session.tabs.createTerminal` run before typing a resume.
    await expect(
      assertLegacyAiVaultResumeCommandAllowed('claude --resume 0f9c1d2e', async () => {
        await install()
      })
    ).resolves.toBeUndefined()
    await expect(
      assertLegacyAiVaultResumeCommandAllowed('claude --resume 0f9c1d2e', async () => {
        throw new Error('the host would not construct')
      })
    ).rejects.toThrow('the host would not construct')
    expect(gateRefusal().reason).toBe('journalCorrupt')
  })

  it('still fails on an install error that refuses nothing', async () => {
    const { runtime, refreshPtyRecords } = startupRuntime(async () => {
      throw new Error('the host would not construct')
    })

    await expect(runtime.prepareStructuredAgentSessionStartupRestoration()).rejects.toThrow(
      'the host would not construct'
    )
    expect(refreshPtyRecords).not.toHaveBeenCalled()
  })
})

describe('stopping', () => {
  it('keeps the connection until a journal close that failed is retried and goes through', async () => {
    await install()
    const close = JournalHostDatabase.prototype.close
    let connectionClose: ReturnType<typeof vi.fn> | null = null
    const journalClose = vi
      .spyOn(JournalHostDatabase.prototype, 'close')
      .mockImplementation(function (this: JournalHostDatabase) {
        // The connection's first close fails, as a native close can before it completes.
        connectionClose ??= vi.spyOn(this.db, 'close').mockImplementationOnce(() => {
          throw new Error('unable to close due to unfinalized statements')
        })
        return close.call(this)
      })
    const journal = () => journalClose.mock.contexts[0]

    await expect(stopStructuredAgentSessionRuntime()).rejects.toThrow('unable to close')
    expect(journal()).toHaveProperty('isClosed', false)

    await stopStructuredAgentSessionRuntime()
    expect(connectionClose).toHaveBeenCalledTimes(2)
    expect(journal()).toHaveProperty('isClosed', true)
  })
})
