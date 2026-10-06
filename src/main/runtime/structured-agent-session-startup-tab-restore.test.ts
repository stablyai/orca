// With native chat on, the renderer's startup also awaits the chat tab restore (`session.tabs.listAll`),
// which reads every chat whose tab was open at quit. That read must not wait on record-store
// bookkeeping: with a saved tab index it writes nothing, and a store that cannot be written costs
// a bounded number of failed writes, not one per chat.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import { journalDatabasePath } from '../native-chat/agent-session-journal/journal-host-database'
import {
  closeTestJournalHostDatabases,
  SAVED_BY_NEWER_ORCA
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { openAgentSessionJournal } from '../native-chat/agent-session-journal/journal-store-factory'
import { journalIdentityFor } from '../native-chat/agent-session-wire/structured-agent-session-attach'
import { attachParamsForRecord } from '../native-chat/agent-session-wire/structured-agent-session-conversation-open'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { AgentSessionRecordStore } from './agent-session-record-store'
import type * as AgentSessionRecordRows from './agent-session-record-rows'
import {
  AGENT_SESSION_STORE_SCHEMA_VERSION,
  legacyAgentSessionStorePath
} from './agent-session-record-store-file'
import {
  readPersistedTestAgentSessionStore,
  seedTestAgentSessionStoreFromNewerBuild,
  storedTestAgentSessionRecord
} from './agent-session-record-store-test-harness'
import { openStructuredAgentSessionJournalDatabase } from './structured-agent-session-journal-open'
import { OrcaRuntimeService } from './orca-runtime'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { recordingStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'

// `failing` fails every record write; `grants` lets that many more through, then fails.
const writes = vi.hoisted(() => ({ failing: false, grants: Infinity, refused: 0 }))

vi.mock('./agent-session-record-rows', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentSessionRecordRows>()
  return {
    ...actual,
    writeAgentSessionStoreRows: (...args: Parameters<typeof actual.writeAgentSessionStoreRows>) => {
      if (writes.failing || writes.grants <= 0) {
        writes.refused += 1
        throw new Error('disk I/O error')
      }
      writes.grants -= 1
      return actual.writeAgentSessionStoreRows(...args)
    }
  }
})

const PROMPT = 'add a retry'
const CHAT_A = 'chat-a-0001'
const CHAT_B = 'chat-b-0002'
const CLEARED = 'chat-s-0003'
const OWED = 'chat-o-0004'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-startup-tab-restore-'))
})

afterEach(async () => {
  Object.assign(writes, { failing: false, grants: Infinity, refused: 0 })
  await stopStructuredAgentSessionRuntime().catch(() => undefined)
  closeTestJournalHostDatabases()
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

/** A released chat, so no startup probe looks for a live owner. */
function chatRecord(
  sessionId: string,
  options: { codex?: boolean; clearedInto?: string } = {}
): AgentSessionRecord {
  const record = agentSessionRecordFixture(
    agentSessionLeaseFixture({
      sessionId,
      ownerProcess: null,
      reservedSpawnToken: null,
      claimStatus: 'released'
    })
  )
  const codex = options.codex
    ? {
        provider: 'codex' as const,
        providerHandleChain: record.providerHandleChain.map((link) => ({
          ...link,
          handle: codexProviderHandle(`thread-${sessionId}`)
        })),
        accountHome: { variable: 'CODEX_HOME' as const, path: join(root, 'codex-home') }
      }
    : {}
  const clear = options.clearedInto
    ? {
        conversationCommand: {
          command: 'clear' as const,
          state: 'completed' as const,
          phase: 'committed' as const,
          operationId: `clear-${sessionId}`,
          callerKey: 'client-1',
          replacementSessionId: options.clearedInto
        }
      }
    : {}
  return { ...record, ...codex, ...clear }
}

/** The records file a profile from before the chat database carries, which the install imports;
 *  `visible` is its saved tab index, absent on a legacy profile. `newer` instead leaves the records
 *  in a database a newer Orca wrote. Then each chat's history as the last run left it: one prompt,
 *  accepted, so nothing is left to send. */
async function seedProfile(
  records: AgentSessionRecord[],
  options: { newer?: boolean; visible?: string[]; history?: AgentSessionRecord[] } = {}
) {
  await mkdir(dirname(legacyAgentSessionStorePath(root)), { recursive: true })
  await writeFile(
    legacyAgentSessionStorePath(root),
    JSON.stringify({
      schemaVersion: AGENT_SESSION_STORE_SCHEMA_VERSION,
      hostId: 'local',
      records: Object.fromEntries(
        records.map((record) => [record.sessionId, storedTestAgentSessionRecord(record)])
      ),
      operations: {},
      retiredClaimKeys: [],
      unusableRecords: {},
      ...(options.visible ? { visibleSessionIds: options.visible } : {})
    })
  )
  const database = await openStructuredAgentSessionJournalDatabase({
    logger: createStructuredAgentSessionLogger(),
    stateDirectory: root,
    hostId: 'local'
  })
  for (const record of options.history ?? records) {
    const fence = record.lease.runtimeFence
    const journal = await openAgentSessionJournal({
      identity: journalIdentityFor(
        record,
        attachParamsForRecord(record, { clientOperationId: 'seed', expectedRuntimeFence: fence })
      ),
      database
    })
    await journal.appendSubmission({
      clientMessageId: 'client-1',
      payloadFingerprint: 'fp-1',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: PROMPT }] },
      fence,
      handoverRecorded: true
    })
    await journal.resolveDispatch({
      clientMessageId: 'client-1',
      fence,
      state: 'accepted',
      providerIdentity: null
    })
    await journal.close()
  }
  database.close()
  if (options.newer) {
    await seedTestAgentSessionStoreFromNewerBuild(root)
  }
  return { path: journalDatabasePath(root) }
}

/** A chat opened, with its tab, while the records file could not be read and the copy was owed. */
async function seedChatOpenedWhileOwed(record: AgentSessionRecord, tabId: string): Promise<void> {
  // A directory where the file belongs: the read fails in a way that can clear.
  await mkdir(legacyAgentSessionStorePath(root), { recursive: true })
  const database = await openStructuredAgentSessionJournalDatabase({
    logger: createStructuredAgentSessionLogger(),
    stateDirectory: root,
    hostId: 'local'
  })
  database.db
    .prepare('INSERT INTO agent_session_records (session_id, record_json) VALUES (?, ?)')
    .run(record.sessionId, JSON.stringify(storedTestAgentSessionRecord(record)))
  await AgentSessionRecordStore.open({
    journalDatabase: database,
    hostId: 'local'
  }).setSessionTabVisibility(record.sessionId, true, tabId)
  database.close()
  await rm(legacyAgentSessionStorePath(root), { recursive: true })
}

function startupRuntime(options: { afterInstall?: () => void; profileChats?: string[] } = {}) {
  const log = recordingStructuredAgentSessionLogger()
  const runtime = new OrcaRuntimeService()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are the runtime's own protected members; the test roots the host at `root`, stubs the PTY daemon and gives it a profile.
  const internal = runtime as unknown as {
    hasPersistedStructuredAgentSessionStore(): boolean
    ensureStructuredAgentSessionHost(): Promise<unknown>
    refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
    mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
    store: { getWorkspaceSession: () => unknown }
  }
  internal.hasPersistedStructuredAgentSessionStore = () => true
  internal.ensureStructuredAgentSessionHost = async () => {
    const installed = await ensureStructuredAgentSessionHost({
      logger: log.logger,
      stateDirectory: root,
      hostId: 'local',
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => root,
      resolveEnvironment: async () => ({}),
      resolveClaudeAuthPolicy: () => ({ stripAuthEnv: true })
    })
    options.afterInstall?.()
    return installed
  }
  internal.refreshMobileSessionPtyRecords = async () => new Set<string>()
  // A legacy profile's saved chat tabs, which a store with no tab index restores from.
  internal.store = {
    getWorkspaceSession: () => ({
      activeRepoId: null,
      activeWorktreeId: 'workspace-1',
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      unifiedTabs: {
        'workspace-1': (options.profileChats ?? []).map((sessionId, index) => ({
          id: `agent-session:${sessionId}`,
          entityId: sessionId,
          groupId: 'group-1',
          worktreeId: 'workspace-1',
          contentType: 'agent-session',
          label: 'Codex Chat',
          customLabel: null,
          color: null,
          sortOrder: index,
          createdAt: 1
        }))
      }
    })
  }
  return {
    runtime,
    log,
    published: () => internal.mobileSessionTabsByWorktree.get('workspace-1')?.tabs ?? []
  }
}

async function expectHistory(sessionId: string): Promise<void> {
  const host = getStructuredAgentSessionHost()
  expect(JSON.stringify((await host!.journalSnapshot(sessionId)).items)).toContain(PROMPT)
}

function spyOnTabWrites() {
  return {
    visibility: vi.spyOn(AgentSessionRecordStore.prototype, 'setSessionTabVisibility'),
    seed: vi.spyOn(AgentSessionRecordStore.prototype, 'showSessionTabs')
  }
}

async function tabIndexOnDisk(): Promise<string[] | undefined> {
  return (await readPersistedTestAgentSessionStore(root)).sessionTabs?.map((tab) => tab.sessionId)
}

describe('restoring the chat tabs open at quit', () => {
  it.each([
    { store: 'records a newer Orca wrote', newer: true, writesFail: false },
    { store: 'a store whose writes keep failing', newer: false, writesFail: true }
  ])(
    'lists every chat from $store and writes nothing; it reads them unless a newer Orca saved them',
    async ({ newer, writesFail }) => {
      const records = [
        chatRecord(CHAT_A),
        chatRecord(CHAT_B),
        chatRecord(CLEARED, { clearedInto: CHAT_A })
      ]
      const { path } = await seedProfile(records, {
        newer,
        visible: [CHAT_A, CHAT_B],
        history: records.slice(0, 2)
      })
      const bytes = await readFile(path)
      const tabWrites = spyOnTabWrites()
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      // Writable when the store opens, then failing for good.
      const { runtime, log, published } = startupRuntime({
        afterInstall: () => {
          writes.failing = writesFail
        }
      })

      await expect(runtime.restoreStructuredAgentSessionTabs()).resolves.toBeUndefined()

      expect(published().map((tab) => tab.id)).toEqual([
        `agent-session:${CHAT_A}`,
        `agent-session:${CHAT_B}`
      ])
      expect(published()[0]).toMatchObject({ replacesSessionId: CLEARED })
      // A newer Orca's leases are adjudicated in memory, so nothing fails there; its chats do not open.
      if (newer) {
        for (const sessionId of [CHAT_A, CHAT_B]) {
          await expect(
            getStructuredAgentSessionHost()!.journalSnapshot(sessionId)
          ).rejects.toMatchObject(SAVED_BY_NEWER_ORCA)
        }
        expect(log.entries.map((entry) => entry.fields.scope)).not.toContain('lease-reconcile')
      } else {
        await expectHistory(CHAT_A)
        await expectHistory(CHAT_B)
        expect(log.entries).toEqual([
          expect.objectContaining({
            fields: {
              scope: 'lease-reconcile',
              error: expect.objectContaining({ message: 'disk I/O error' })
            }
          })
        ])
      }
      expect(tabWrites.visibility).not.toHaveBeenCalled()
      expect(tabWrites.seed).not.toHaveBeenCalled()
      await stopStructuredAgentSessionRuntime()
      if (newer) {
        expect(await readFile(path)).toEqual(bytes)
      }
    }
  )

  // Each failed write stands for one refused commit.
  it.each([1, 4, 8])('fails one write per startup step with %i chats open', async (count) => {
    const chats = Array.from({ length: count }, (_, index) => `chat-${index}-000${index}`)
    const records = chats.map((sessionId) => chatRecord(sessionId))
    await seedProfile(records, { visible: chats })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { runtime, published } = startupRuntime({
      afterInstall: () => {
        writes.failing = true
      }
    })

    await runtime.prepareStructuredAgentSessionStartupRestoration()
    const prepared = writes.refused
    await runtime.restoreStructuredAgentSessionTabs()

    expect(published()).toHaveLength(count)
    expect(prepared).toBe(1)
    expect(writes.refused - prepared).toBe(1)
  })

  describe('on a legacy profile, with no tab index yet', () => {
    const legacyChats = () => [
      chatRecord(CHAT_A, { codex: true }),
      chatRecord(CHAT_B, { codex: true })
    ]

    it('records every restored chat in one write', async () => {
      const records = legacyChats()
      await seedProfile(records)
      const tabWrites = spyOnTabWrites()
      const { runtime, published } = startupRuntime({ profileChats: [CHAT_A, CHAT_B] })
      await runtime.prepareStructuredAgentSessionStartupRestoration()
      // One more write, then failing: a seed written chat by chat would stop part way.
      writes.grants = 1

      await runtime.restoreStructuredAgentSessionTabs()

      expect(published().map((tab) => tab.id)).toEqual([
        `agent-session:${CHAT_A}`,
        `agent-session:${CHAT_B}`
      ])
      expect(await tabIndexOnDisk()).toEqual([CHAT_A, CHAT_B])
      expect(tabWrites.seed).toHaveBeenCalledOnce()
      expect(tabWrites.visibility).not.toHaveBeenCalled()
    })

    it('fails one write more, for that one write', async () => {
      const records = legacyChats()
      await seedProfile(records)
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const { runtime, published } = startupRuntime({
        profileChats: [CHAT_A, CHAT_B],
        afterInstall: () => {
          writes.failing = true
        }
      })

      await runtime.prepareStructuredAgentSessionStartupRestoration()
      const prepared = writes.refused
      await runtime.restoreStructuredAgentSessionTabs()

      expect(published()).toHaveLength(2)
      expect(prepared).toBe(1)
      // The restore's lease check and the seed.
      expect(writes.refused - prepared).toBe(2)
    })

    // The profile never lists a Claude chat, so only the tab row that chat left brings it back.
    it("restores a chat opened while the copy was owed beside the profile's chats", async () => {
      const owed = chatRecord(OWED)
      await seedChatOpenedWhileOwed(owed, 'tab-opened-while-owed')
      const records = [chatRecord(CHAT_A, { codex: true })]
      await seedProfile(records, { history: [owed, ...records] })
      const { runtime, published } = startupRuntime({ profileChats: [CHAT_A] })

      await runtime.restoreStructuredAgentSessionTabs()

      expect(published().map((tab) => tab.id)).toEqual([
        `agent-session:${OWED}`,
        `agent-session:${CHAT_A}`
      ])
      expect((await readPersistedTestAgentSessionStore(root)).sessionTabs).toEqual([
        { tabId: 'tab-opened-while-owed', sessionId: OWED },
        { tabId: `structured-agent-session-${CHAT_A}`, sessionId: CHAT_A }
      ])
    })

    it('still lists the chats when that write fails, and leaves the index absent', async () => {
      const records = legacyChats()
      await seedProfile(records)
      const { runtime, published, log } = startupRuntime({ profileChats: [CHAT_A, CHAT_B] })
      await runtime.prepareStructuredAgentSessionStartupRestoration()
      writes.failing = true

      await expect(runtime.restoreStructuredAgentSessionTabs()).resolves.toBeUndefined()

      expect(published()).toHaveLength(2)
      await expectHistory(CHAT_A)
      expect(log.entries).toContainEqual({
        level: 'warn',
        message: 'recording restored chat tabs failed',
        fields: {
          scope: 'tab-index-seed',
          sessionIds: [CHAT_A, CHAT_B],
          error: expect.objectContaining({ message: 'disk I/O error' })
        }
      })
      expect(await tabIndexOnDisk()).toBeUndefined()
    })
  })
})
