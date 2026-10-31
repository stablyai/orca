import { partialRuntimeStore } from './runtime-store-partial-fixture'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
// Startup chat-tab restore must write nothing with an existing index and bound failed writes per step rather than per chat.

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import { journalDatabasePath } from '../native-chat/agent-session-journal/journal-host-database'
import {
  closeTestJournalHostDatabase,
  closeTestJournalHostDatabases,
  insertTestJournalRowJson,
  openTestJournalHostDatabase,
  SAVED_BY_NEWER_ORCA
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import * as journalFactory from '../native-chat/agent-session-journal/journal-store-factory'
import { publishJournalSessionEpoch } from '../native-chat/agent-session-journal/journal-row-table'
import { createQueuedRigProvider } from '../native-chat/agent-session-wire/structured-agent-session-queued-message-rig-provider.test-fixture'
import { createStructuredSessionObservationClock } from '../native-chat/agent-session-wire/structured-agent-session-observation-clock.test-fixture'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { mintAgentSessionOperationId } from './orchestration/structured-pointer-operation-id'
import { journalIdentityFor } from '../native-chat/agent-session-wire/structured-agent-session-attach'
import { attachParamsForRecord } from '../native-chat/agent-session-wire/structured-agent-session-conversation-open'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { AgentSessionRecordStore } from './agent-session-record-store'
import type * as AgentSessionRecordRows from './agent-session-record-rows'
import {
  readPersistedTestAgentSessionStore,
  seedTestAgentSessionRecordStore,
  seedTestAgentSessionStoreFromNewerBuild
} from './agent-session-record-store-test-harness'
import { OrcaRuntimeService } from './orca-runtime'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import { recordingStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { structuredAgentSessionTabId } from '../../shared/structured-agent-session-projection'

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

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-startup-tab-restore-'))
})

afterEach(async () => {
  Object.assign(writes, { failing: false, grants: Infinity, refused: 0 })
  await stopStructuredAgentSessionRuntime().catch(() => undefined)
  await closeTestJournalHostDatabases()
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

/** Seed released records and one accepted prompt each; visible is absent for legacy profiles, newer stamps a later database version. */
async function seedProfile(
  records: AgentSessionRecord[],
  options: { newer?: boolean; visible?: string[]; history?: AgentSessionRecord[] } = {}
) {
  await seedTestAgentSessionRecordStore(root, {
    records,
    ...(options.visible
      ? {
          sessionTabs: options.visible.map((sessionId) => ({
            tabId: structuredAgentSessionTabId(sessionId),
            sessionId
          }))
        }
      : {})
  })
  const database = openTestJournalHostDatabase(root)
  for (const record of options.history ?? records) {
    const fence = record.lease.runtimeFence
    const journal = await journalFactory.openAgentSessionJournal({
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
  await closeTestJournalHostDatabase(root)
  if (options.newer) {
    await seedTestAgentSessionStoreFromNewerBuild(root)
  }
  return { path: journalDatabasePath(root) }
}

function startupRuntime(options: { afterInstall?: () => void; profileChats?: string[] } = {}) {
  const log = recordingStructuredAgentSessionLogger()
  // A legacy profile's saved chat tabs, which a store with no tab index restores from.
  const profile: WorkspaceSessionState = {
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
  }
  class StartupRuntime extends OrcaRuntimeService {
    protected override hasPersistedStructuredAgentSessionStore() {
      return true
    }
    protected override async refreshMobileSessionPtyRecords() {
      return new Set<string>()
    }
    override async ensureStructuredAgentSessionHost() {
      await ensureStructuredAgentSessionHost({
        logger: log.logger,
        stateDirectory: root,
        hostId: 'local',
        claimKeyId: 'key-1',
        legacySessionTabIds: this.legacyStructuredSessionTabIds,
        resolveWorkspacePath: async () => root,
        resolveEnvironment: async () => ({}),
        resolveLaunchArgs: () => [],
        resolveClaudeAuthPolicy: () => ({ account: 'managed' })
      })
      options.afterInstall?.()
    }
  }
  const runtime = new StartupRuntime(partialRuntimeStore({ getWorkspaceSession: () => profile }))
  return {
    runtime,
    log,
    published: () => runtime.mobileSessionTabsByWorktree.get('workspace-1')?.tabs ?? []
  }
}

async function expectHistory(sessionId: string): Promise<void> {
  const host = getStructuredAgentSessionHost()
  expect(JSON.stringify((await host!.journalSnapshot(sessionId)).items)).toContain(PROMPT)
}

function spyOnTabWrites() {
  return {
    visibility: vi.spyOn(AgentSessionRecordStore.prototype, 'setSessionTabVisibility'),
    seed: vi.spyOn(AgentSessionRecordStore.prototype, 'initializeSessionTabs')
  }
}

async function tabIndexOnDisk(): Promise<string[] | undefined> {
  return (await readPersistedTestAgentSessionStore(root)).sessionTabs?.map((tab) => tab.sessionId)
}

describe('restoring the chat tabs open at quit', () => {
  it('keeps recorded Codex queue admission through startup and physical reopen until Steer', async () => {
    const sessionId = 'codex_921935f3_cbca_41e4_8b82_220245b3ecd4'
    const epoch = '13c4e01d-1d1f-41bc-932a-629bf803c4a1'
    const messageId = '1793285151845-19784765711d4fa6aa7a71b754b8574d'
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Reply exactly QA3231_CODEX_KEPT_REPLY1_OK' }]
    }
    // codex-main79-immutable-raw.json SHA25645767f7ef2a1ae7d44767fd4c79b4d9717c73f3548dc15205449a5812e4ba067: original rows from the stopped upgraded DB.
    // Select the committed admission before seq3 handover, not an observed kept card or pre-upgrade DB snapshot.
    const recordedRows = [
      {
        seq: 1,
        ts: 1793285143624,
        json: '{"kind":"epoch","reason":"session_created","providerHandle":{"kind":"opaque","agent":"codex","value":"pending"},"v":2,"epoch":"13c4e01d-1d1f-41bc-932a-629bf803c4a1","seq":1,"fence":0,"ts":1793285143624}'
      },
      {
        seq: 2,
        ts: 1793285151851,
        json: '{"kind":"submission","clientMessageId":"1793285151845-19784765711d4fa6aa7a71b754b8574d","payloadFingerprint":"8d7b18e93fb35212a3f33ebb3781abf2708cace17a461933ad7c235cef55e7fd","providerHandle":{"kind":"opaque","agent":"codex","value":"pending"},"body":{"kind":"message","role":"user","blocks":[{"type":"text","text":"Reply exactly QA3231_CODEX_KEPT_REPLY1_OK"}]},"v":2,"epoch":"13c4e01d-1d1f-41bc-932a-629bf803c4a1","seq":2,"fence":1,"ts":1793285151851,"handoverRecorded":true,"origin":"client","source":{"kind":"user"},"options":{}}'
      }
    ]
    const record = chatRecord(sessionId, { codex: true })
    // Companion record/profile are fixtures; only these two raw journal rows are recorded state.
    await seedProfile([record], { visible: [sessionId], history: [] })
    const database = openTestJournalHostDatabase(root)
    publishJournalSessionEpoch(
      database.db,
      { sessionId, workspaceId: record.location.workspaceId },
      epoch
    )
    for (const row of recordedRows) {
      insertTestJournalRowJson(database.db, sessionId, row.seq, row.json, row.ts)
    }
    await closeTestJournalHostDatabase(root)

    const installs: {
      host: StructuredAgentSessionHost
      provider: ReturnType<typeof createQueuedRigProvider>
    }[] = []
    const installProvider = () => {
      const host = getStructuredAgentSessionHost()
      if (!host) {
        throw new Error('production runtime did not install its host')
      }
      if (installs.some((installed) => installed.host === host)) {
        return
      }
      const provider = createQueuedRigProvider(host.deps.store, { restartable: true }, () => host)
      Object.assign(host.deps.adapter, provider.adapter, { disposeSession: provider.closeSession })
      installs.push({ host, provider })
    }
    const current = () => {
      const installed = installs.at(-1)
      if (!installed) {
        throw new Error('no installed test provider')
      }
      return installed
    }
    const clock = createStructuredSessionObservationClock(() => current().host, sessionId)
    const expectWaitingCard = async (host: StructuredAgentSessionHost) => {
      const history = await host.history({ sessionId, direction: 'tail' })
      if (!history.ok) {
        throw new Error('recorded conversation history refused')
      }
      expect(history.page.queuedMessages).toEqual([
        { messageId, position: 0, state: 'waiting', body }
      ])
      const original = (await host.journalSnapshot(sessionId)).submissions
      expect(original).toHaveLength(1)
      expect(original[0]).toMatchObject({
        clientMessageId: messageId,
        acceptedSequence: 2,
        dispatchState: 'rejected',
        keptAsQueuedMessageId: messageId,
        handoverRecorded: true,
        origin: 'client',
        source: { kind: 'user' },
        options: {}
      })
      expect(original[0]?.handedOverAt).toBeUndefined()
    }
    const now = 1_793_285_160_000
    try {
      const opens = vi.spyOn(journalFactory, 'openAgentSessionJournal')
      const firstRuntime = startupRuntime({
        profileChats: [sessionId],
        afterInstall: installProvider
      })
      await firstRuntime.runtime.restoreStructuredAgentSessionTabs()
      const first = current()
      expect(firstRuntime.published().map((tab) => tab.id)).toEqual([`agent-session:${sessionId}`])
      expect(opens).not.toHaveBeenCalled()
      expect(first.provider.starts).not.toHaveBeenCalled()
      expect(first.provider.dispatch).not.toHaveBeenCalled()
      await expect(first.host.revealSession(sessionId)).resolves.toMatchObject({
        sessionId,
        readable: true
      })
      expect(opens).toHaveBeenCalledOnce()
      await expectWaitingCard(first.host)
      clock.start()
      vi.setSystemTime(now)
      await clock.observe(100)
      expect(first.provider.starts).not.toHaveBeenCalled()
      expect(first.provider.dispatch).not.toHaveBeenCalled()

      const firstDatabase = first.host.deps.journalDatabase
      clock.restore()
      await stopStructuredAgentSessionRuntime()
      expect(firstDatabase.isClosed).toBe(true)
      await closeTestJournalHostDatabases()
      opens.mockClear()
      const nextRuntime = startupRuntime({
        profileChats: [sessionId],
        afterInstall: installProvider
      })
      await nextRuntime.runtime.restoreStructuredAgentSessionTabs()
      const next = current()
      expect(next.host).not.toBe(first.host)
      expect(next.host.deps.store).not.toBe(first.host.deps.store)
      expect(next.host.deps.journalDatabase).not.toBe(firstDatabase)
      expect(nextRuntime.published().map((tab) => tab.id)).toEqual([`agent-session:${sessionId}`])
      expect(opens).not.toHaveBeenCalled()
      expect(next.provider.starts).not.toHaveBeenCalled()
      expect(next.provider.dispatch).not.toHaveBeenCalled()
      await expect(next.host.revealSession(sessionId)).resolves.toMatchObject({
        sessionId,
        readable: true
      })
      expect(opens).toHaveBeenCalledOnce()
      await expectWaitingCard(next.host)
      clock.start()
      vi.setSystemTime(now)
      await clock.observe(100)
      expect(next.provider.starts).not.toHaveBeenCalled()
      expect(next.provider.dispatch).not.toHaveBeenCalled()

      const operationId = mintAgentSessionOperationId(now)
      const liveRecord = next.host.deps.store.getRecord(sessionId)
      if (!liveRecord) {
        throw new Error('recorded conversation disappeared')
      }
      const sent = await next.host.queuedMessageSend(
        { callerKey: 'client-1' },
        {
          envelope: {
            sessionId,
            clientOperationId: operationId,
            expectedRuntimeFence: liveRecord.lease.runtimeFence,
            payloadFingerprint: computeAgentSessionPayloadFingerprint({
              method: 'agentSession.queuedMessageSend',
              sessionId,
              fields: { messageId }
            })
          },
          messageId
        }
      )
      expect(sent).toMatchObject({
        ok: true,
        value: { clientMessageId: operationId, submission: { queuedMessageId: messageId } }
      })
      expect(operationId).not.toBe(messageId)
      await vi.waitFor(() => expect(next.provider.dispatch).toHaveBeenCalledTimes(1))
      expect(next.provider.starts).toHaveBeenCalledOnce()
      expect(next.provider.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId,
          clientMessageId: operationId,
          body,
          executionOptions: {}
        })
      )
      const delivered = await next.host.history({ sessionId, direction: 'tail' })
      if (!delivered.ok) {
        throw new Error('delivered conversation history refused')
      }
      expect(delivered.page.queuedMessages).toEqual([])
      expect(
        (await next.host.journalSnapshot(sessionId)).submissions.filter(
          (entry) => entry.queuedMessageId === messageId
        )
      ).toEqual([
        expect.objectContaining({
          clientMessageId: operationId,
          queuedMessageId: messageId,
          origin: 'client',
          options: {}
        })
      ])
      await clock.observe(100)
      expect(next.provider.dispatch).toHaveBeenCalledTimes(1)
      expect(first.provider.dispatch).not.toHaveBeenCalled()
      clock.restore()
      await stopStructuredAgentSessionRuntime()
      expect(next.host.deps.journalDatabase.isClosed).toBe(true)
    } finally {
      clock.restore()
    }
  })
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
      expect(
        published().every(
          (tab) => tab.type !== 'agent-session' || tab.replacesSessionId === undefined
        )
      ).toBe(true)
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
      // Allow one write; a per-chat seed would publish an incomplete index.
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
          error: expect.objectContaining({ message: 'disk I/O error' })
        }
      })
      expect(await tabIndexOnDisk()).toBeUndefined()
    })
  })
})
