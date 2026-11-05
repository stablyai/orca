import { mutateTestJournalFixture } from '../../../native-chat/agent-session-journal/journal-drained-fixture-test-support'
import { windowSaveKeepingMainSleepRecords } from '../../../persistence/window-save-sleep-records'
import { readPersistedState } from '../../../persistence/persistence-test-harness'
import {
  isSurfaceEvidenceDomain,
  surfaceEvidenceDocumentSchema
} from '../../../../shared/workspace-surfaces/surface-evidence-document'
import { windowViewSaveForMain } from '../../../persistence/window-save-view'
import { failNativeJournalStatements } from '../../../native-chat/agent-session-journal/journal-native-test-instrumentation'
import '../../rpc/unused-default-rpc-methods.test-fixture'
import { beforeEach, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../rpc/dispatcher'
import { ORCHESTRATION_CALLER_METHODS } from '../../rpc/methods/orchestration/caller-show'
import { STRUCTURED_AGENT_SESSION_REVEAL_METHODS } from '../../rpc/methods/structured-agent-session-reveal'
import {
  seedTestAgentSessionStoreFromNewerBuild,
  readPersistedTestAgentSessionStore,
  editPersistedTestAgentSessionStore
} from '../records/agent-session-record-store-test-harness'
import { STRUCTURED_AGENT_SESSION_STATUS_METHODS } from '../../rpc/methods/structured-agent-session-status-stream'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/agent-session/agent-session-runtime-capabilities'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import {
  root,
  B,
  C,
  G,
  AuthorityRuntime,
  authorityProfile,
  openAuthorityRuntime,
  createC,
  holdStartup,
  physicalReload,
  rejectVisibility,
  replaceSaved,
  savedIds,
  savedSnapshot
} from './structured-agent-session-tab-authority.test-support'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { chatTabCommandsSettled } from '../../orca-runtime-tests/session-layout-apply.test-fixture'
import * as journalFactory from '../../../native-chat/agent-session-journal/journal-store-factory'
import { discardStructuredWorkerSession } from '../../rpc/methods/orchestration-structured-worker-session'
import { closeStructuredAgentSessionChild } from '../structured-agent-session-close'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from '../../../native-chat/agent-session-journal/journal-host-database-test-support'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'

// CLI capability probing is outside tab authority and must not start a real CLI in this fixture.
vi.mock('../../../claude/claude-cli-flag-prewarm', () => ({
  prewarmClaudeCliFlags: async () => undefined
}))

const layoutOwner = vi.hoisted(() => ({ main: false }))
vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.main
  }
}))
beforeEach(() => {
  layoutOwner.main = false
})

it('captures persisted folder attention without installing the chat host or opening a conversation', async () => {
  const profile = await authorityProfile([B])
  await editPersistedTestAgentSessionStore(root, (persisted) => {
    persisted.records[B].location.workspaceKind = 'folder'
  })
  const journals = createTrackedJournalOpener()
  const journal = await journals.open({
    stateDirectory: root,
    identity: {
      sessionId: B,
      workspaceId: profile.workspace,
      hostId: 'local',
      agent: 'claude',
      providerHandle: null
    }
  })
  const physicalEpoch = journal.cursor().epoch
  await journal.replaceEpochItems('handle_forked', 0, [
    {
      identity: { provider: 'orca', clientMessageId: 'kept-history' },
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'retained history' }] },
      ownerFence: 0,
      turnScope: { kind: 'thread' }
    }
  ])
  const cursor = journal.cursor()
  expect(cursor.epoch).not.toBe(physicalEpoch)
  await journals.closeAll()
  const runtime = new AuthorityRuntime(profile.profile)
  const ensureHost = vi
    .spyOn(runtime, 'ensureStructuredAgentSessionHost')
    .mockRejectedValue(new Error('acknowledgement must not install providers'))
  const openConversation = vi.spyOn(journalFactory, 'openAgentSessionJournal')

  expect(getStructuredAgentSessionHost()).toBeNull()
  const acknowledgement = await runtime.prepareWorkspaceAttentionAcknowledgement(
    `id:${profile.workspace}`
  )
  const scope = {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: profile.workspace,
    workspaceKind: 'folder'
  }
  expect(acknowledgement).toEqual({
    worktree: scope,
    reads: [{ sessionId: B, scope, observedCursor: cursor }]
  })
  expect(ensureHost).not.toHaveBeenCalled()
  expect(openConversation).not.toHaveBeenCalled()
  expect(getStructuredAgentSessionHost()).toBeNull()
})

it.each([false, true])(
  'imports legacy saved chats before a stale snapshot and preserves them through create/reload, firstMessage=%s',
  async (first) => {
    const profile = await authorityProfile([G, B], { legacy: true })
    const runtime = new AuthorityRuntime(profile.profile)
    replaceSaved(profile, [])
    const rig = await openAuthorityRuntime(profile, runtime)
    expect(runtime.capturedSelection()).toEqual([G, B])
    expect(rig.host.deps.store).toBe(rig.store)
    expect(rig.host.getPersistedVisibleSessionTabIndex().present).toBe(true)
    expect(await createC(rig, first)).toMatchObject({ ok: true })
    expect(rig.host.getPersistedVisibleSessionTabIndex()).toEqual({
      present: true,
      sessionIds: [B, C]
    })
    const journal = vi.spyOn(journalFactory, 'openAgentSessionJournal')
    await rig.runtime.restoreStructuredAgentSessionTabs()
    await chatTabCommandsSettled()
    expect(journal).not.toHaveBeenCalled()
    expect(rig.host.listSessionTabs().map((row) => row.sessionId)).toEqual([B, C])
    expect(savedIds(rig)).toEqual(expect.arrayContaining([B, C]))
    expect(rig.acquire).not.toHaveBeenCalled()
    const fresh = await physicalReload(rig)
    expect(fresh.profile).not.toBe(rig.profile)
    expect(fresh.store).not.toBe(rig.store)
    expect(fresh.host.deps.journalDatabase).not.toBe(rig.host.deps.journalDatabase)
    expect(fresh.host.getPersistedVisibleSessionTabIndex().sessionIds).toEqual([B, C])
    const references = Object.entries(readPersistedState())
      .filter(([domain]) => isSurfaceEvidenceDomain(domain))
      .map(([, value]) => surfaceEvidenceDocumentSchema.parse(value))
    expect(references).toContainEqual(
      expect.objectContaining({
        kind: 'reference',
        value: expect.objectContaining({
          id: structuredAgentSessionTabId(G),
          raw: expect.objectContaining({ contentType: 'agent-session', entityId: G })
        })
      })
    )
  }
)

it('a refused first import adopts nothing and retries the same captured selection', async () => {
  const profile = await authorityProfile([G, B], { legacy: true })
  const runtime = new AuthorityRuntime(profile.profile)
  replaceSaved(profile, [])
  await mutateTestJournalFixture(await openTestJournalHostDatabase(root), (db) => {
    db.exec(
      "CREATE TRIGGER reject_first_import BEFORE INSERT ON agent_session_store_meta WHEN NEW.key='session_tabs_recorded' BEGIN SELECT RAISE(ABORT, 'first import rejected'); END"
    )
  })
  await expect(openAuthorityRuntime(profile, runtime)).rejects.toThrow('first import rejected')
  expect(
    profile.profile.readWorkspaceSurfaces().filter((row) => row.content?.kind === 'agent-session')
  ).toEqual([])
  expect(savedIds(profile)).toEqual([])
  expect(getStructuredAgentSessionHost()).toBeNull()
  expect((await readPersistedTestAgentSessionStore(root)).sessionTabs).toBeUndefined()
  await mutateTestJournalFixture(await openTestJournalHostDatabase(root), (db) => {
    db.exec('DROP TRIGGER reject_first_import')
  })
  const rig = await openAuthorityRuntime(profile, runtime)
  expect(rig.store.listVisibleSessionIds()).toEqual([B])
  expect(rig.acquire).not.toHaveBeenCalled()
  expect((await physicalReload(rig)).store.listVisibleSessionIds()).toEqual([B])
})

it('first import keeps current custom identity and order before the captured supplement', async () => {
  const profile = await authorityProfile([B, C], { legacy: true })
  const runtime = new AuthorityRuntime(profile.profile)
  const current = savedSnapshot(profile, [C])
  const tab = current.unifiedTabs?.[profile.workspace]?.find((row) => row.entityId === C)
  if (!tab) {
    throw new Error('expected the current saved chat')
  }
  tab.id = 'current-c-tab'
  profile.profile.setWorkspaceSession(current)
  const rig = await openAuthorityRuntime(profile, runtime)
  expect(rig.store.listVisibleSessionIds()).toEqual([C, B])
  expect(rig.store.getSessionTabId(C)).toBe('current-c-tab')
  await rig.host.setSessionTabVisibility(B, false)
  const fresh = await physicalReload(rig)
  expect(fresh.store.listVisibleSessionIds()).toEqual([C])
  expect(fresh.store.getSessionTabId(C)).toBe('current-c-tab')
})

it.each([false, true])(
  'rejected hide and create preserve canonical membership through retry/reload, firstMessage=%s',
  async (first) => {
    const rig = await openAuthorityRuntime(await authorityProfile())
    const allow = await rejectVisibility(rig)
    const release = await holdStartup(rig)
    expect(rig.host.getPersistedVisibleSessionTabIndex().present).toBe(true)
    replaceSaved(rig, [])
    await expect(rig.host.setSessionTabVisibility(B, false)).rejects.toThrow('visibility rejected')
    expect(savedIds(rig)).toEqual([])
    expect(rig.store.isSessionTabVisible(B)).toBe(true)
    await (first
      ? expect(createC(rig, first)).resolves.toMatchObject({ ok: false })
      : expect(createC(rig, first)).rejects.toThrow('visibility rejected'))
    expect(rig.store.getRecord(C)).toBeNull()
    expect(rig.host.getPersistedVisibleSessionTabIndex().present).toBe(true)
    await allow()
    expect(await createC(rig, first)).toMatchObject({ ok: true })
    expect(rig.host.getPersistedVisibleSessionTabIndex().sessionIds).toEqual([B, C])
    await release()
    expect(savedIds(rig)).toEqual(expect.arrayContaining([B, C]))
    expect((await physicalReload(rig)).store.listVisibleSessionIds()).toEqual([B, C])
  }
)

it.each([false, true])(
  'refuses a held legacy identity before accepting C/message, firstMessage=%s',
  async (first) => {
    const rig = await openAuthorityRuntime(await authorityProfile())
    expect(await createC(rig, first, structuredAgentSessionTabId(B))).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_conflict', details: { reason: 'tabIdTaken' } }
    })
    expect(rig.store.getRecord(C)).toBeNull()
    expect(rig.host.getPersistedVisibleSessionTabIndex().present).toBe(true)
    expect(rig.acquire).not.toHaveBeenCalled()
    await rig.store.initializeSessionTabs()
    expect(await createC(rig, first, structuredAgentSessionTabId(B))).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'tabIdTaken' } }
    })
    expect(await createC(rig, first, 'free-custom-tab')).toMatchObject({ ok: true })
    expect(rig.store.getSessionTabId(C)).toBe('free-custom-tab')
    expect(rig.store.getSessionTabId(B)).toBe(structuredAgentSessionTabId(B))
  }
)

it.each([false, true])(
  'accepted hide wins over loaded and unopened late saved publication, loaded=%s',
  async (loaded) => {
    const rig = await openAuthorityRuntime(await authorityProfile())
    if (loaded) {
      expect(await rig.host.revealSession(B)).toMatchObject({ readable: true })
    }
    expect(rig.host.hasSession(B)).toBe(loaded)
    rig.runtime.projectStructuredAgentSessionTab({
      workspaceId: rig.workspace,
      sessionId: B,
      agent: 'codex',
      activate: false
    })
    const release = await holdStartup(rig)
    const publish = vi.spyOn(rig.host.deps.statusSink!, 'publish')
    await closeStructuredAgentSessionChild(B, { runtime: rig.runtime })
    expect(rig.runtime.live(B)).toBe(false)
    publish.mockClear()
    await release()
    expect(publish).not.toHaveBeenCalled()
    expect(rig.host.listSessionTabs()).toEqual([])
    expect(rig.runtime.live(B)).toBe(false)
    expect(savedIds(rig)).toEqual([])
    const fresh = await physicalReload(rig)
    expect(fresh.store.getVisibleSessionTabIndex()).toEqual({ present: true, sessionIds: [] })
    expect(fresh.host.listSessionTabs()).toEqual([])
  }
)

it('keeps failed-show Retry live without partial durability and persists a later retry', async () => {
  layoutOwner.main = false
  const rig = await openAuthorityRuntime(await authorityProfile())
  const release = await holdStartup(rig)
  await closeStructuredAgentSessionChild(B, { runtime: rig.runtime })
  const allow = await rejectVisibility(rig)
  await rig.runtime.publishStructuredAgentSessionTab({
    workspaceId: rig.workspace,
    sessionId: B,
    agent: 'codex',
    activate: true
  })
  expect(rig.store.isSessionTabVisible(B)).toBe(false)
  expect(rig.runtime.live(B)).toBe(true)
  await release()
  expect(savedIds(rig)).toEqual([])
  await rig.runtime.publishStructuredAgentSessionTab({
    workspaceId: rig.workspace,
    sessionId: B,
    agent: 'codex',
    activate: true
  })
  await chatTabCommandsSettled()
  expect(savedIds(rig)).toEqual([])
  expect(rig.store.isSessionTabVisible(B)).toBe(false)
  expect(rig.runtime.live(B)).toBe(true)
  const snapshot = rig.runtime.mobileSessionTabsByWorktree.get(rig.workspace)!
  rig.runtime.storeMobileSessionSnapshot(rig.workspace, { ...snapshot, tabs: [] })
  expect(rig.runtime.live(B)).toBe(false)
  rig.runtime.storeMobileSessionSnapshot(rig.workspace, snapshot)
  expect(rig.runtime.live(B)).toBe(true)
  rig.runtime.mobileSessionTabsByWorktree.delete(rig.workspace)
  expect(rig.runtime.live(B)).toBe(false)
  await allow()
  await rig.runtime.publishStructuredAgentSessionTab({
    workspaceId: rig.workspace,
    sessionId: B,
    agent: 'codex',
    activate: true
  })
  await chatTabCommandsSettled()
  expect(savedIds(rig)).toEqual([B])
  expect(rig.store.isSessionTabVisible(B)).toBe(true)
  const fresh = await physicalReload(rig)
  expect(fresh.store.listVisibleSessionIds()).toEqual([B])
  await closeStructuredAgentSessionChild(B, { runtime: fresh.runtime })
  await chatTabCommandsSettled()
  expect(savedIds(fresh)).toEqual([])
})

it.each([false, true])(
  'leaves prior visibility and exact recorded ID untouched after unproven close, custom=%s',
  async (known) => {
    const rig = await openAuthorityRuntime(await authorityProfile())
    if (known) {
      await rig.host.setSessionTabVisibility(B, false)
      await rig.host.setSessionTabVisibility(B, true, 'known-tab')
    }
    const beforeId = rig.store.getSessionTabId(B)
    expect(beforeId).toBe(known ? 'known-tab' : structuredAgentSessionTabId(B))
    await rig.store.transitionHandoff(B, (record) => ({
      ...record,
      lease: { ...record.lease, claimStatus: 'reserved', reservedSpawnToken: 'pending-owner' }
    }))
    vi.spyOn(rig.host, 'close').mockRejectedValueOnce(new Error('child close unproven'))
    const result = await closeStructuredAgentSessionChild(B, { runtime: rig.runtime })
    expect(result).toMatchObject({ stopped: false, closeAttempted: true })
    expect(rig.store.getSessionTabId(B)).toBe(beforeId)
    expect(rig.store.isSessionTabVisible(B)).toBe(true)
  }
)

it('failed worker discard explicitly restores a known tab instead of relying on a loaded handle', async () => {
  const rig = await openAuthorityRuntime(await authorityProfile())
  await rig.host.setSessionTabVisibility(B, false)
  await rig.host.setSessionTabVisibility(B, true, 'worker-tab')
  await rig.store.transitionHandoff(B, (record) => ({
    ...record,
    lease: { ...record.lease, claimStatus: 'reserved', reservedSpawnToken: 'pending-owner' }
  }))
  vi.spyOn(rig.host, 'close').mockRejectedValueOnce(new Error('child close unproven'))
  await discardStructuredWorkerSession(B, rig.runtime)
  expect(rig.store.getSessionTabId(B)).toBe('worker-tab')
  expect(rig.host.listSessionTabs().map((row) => row.sessionId)).toEqual([B])
})

it.each([undefined, [], [C]])(
  'honors absent versus present/empty/old-partial authority: %j',
  async (visible) => {
    const rig = await openAuthorityRuntime(
      await authorityProfile([G, B], { visible, records: [B, C] })
    )
    const journal = vi.spyOn(journalFactory, 'openAgentSessionJournal')
    const transition = vi.spyOn(rig.store, 'transitionHandoff')
    await rig.runtime.restoreStructuredAgentSessionTabs()
    await chatTabCommandsSettled()
    expect(rig.store.listVisibleSessionIds()).toEqual(visible ?? [B])
    expect(savedIds(rig)).toEqual(visible ?? [B])
    expect(journal).not.toHaveBeenCalled()
    expect(transition).not.toHaveBeenCalled()
  }
)

it('records empty membership without deleting unresolved legacy data; a genuine create remains usable', async () => {
  const rig = await openAuthorityRuntime(await authorityProfile([G], { records: [], legacy: true }))
  await rig.runtime.restoreStructuredAgentSessionTabs()
  expect(rig.store.getVisibleSessionTabIndex().present).toBe(true)
  expect(savedIds(rig)).toEqual([])
  await rig.profile.flushPendingOrThrowAsync()
  const references = Object.entries(readPersistedState())
    .filter(([domain]) => isSurfaceEvidenceDomain(domain))
    .map(([, value]) => surfaceEvidenceDocumentSchema.parse(value))
  expect(references).toContainEqual({
    version: 1,
    hostId: 'local',
    kind: 'reference',
    value: {
      workspaceId: rig.workspace,
      kind: 'agent-session',
      id: structuredAgentSessionTabId(G),
      raw: { tabId: structuredAgentSessionTabId(G), sessionId: G, recordJson: null }
    }
  })
  expect(rig.runtime.capturedSelection()).toEqual([G])
  expect(await createC(rig, false)).toMatchObject({ ok: true })
  expect(rig.store.listVisibleSessionIds()).toEqual([C])
})

it.each(['group', 'folder'] as const)(
  'keeps accepted %s removal and does not fabricate an owner from the captured base',
  async (kind) => {
    const rig = await openAuthorityRuntime(await authorityProfile())
    const allow = await rejectVisibility(rig)
    const release = await holdStartup(rig)
    await allow()
    const removed =
      kind === 'group'
        ? await rig.runtime.deleteProjectGroup(rig.groupId)
        : await rig.runtime.deleteFolderWorkspace(rig.folderId)
    expect(removed).toMatchObject({ deleted: true })
    await release()
    expect(rig.profile.getFolderWorkspaces()).toEqual([])
    expect(savedIds(rig)).toEqual([])
    expect(rig.store.getRecord(B)).not.toBeNull()
  }
)

it.each([false, true])(
  'rechecks each queued entry and follows an in-flight open with current close, reopened=%s',
  async (reopened) => {
    layoutOwner.main = true
    const second = 'chat-second-0005'
    const rig = await openAuthorityRuntime(await authorityProfile([B, second]))
    const release = await holdStartup(rig)
    replaceSaved(rig, [])
    const entered = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>()
    const apply = rig.runtime.applyLayoutCommand.bind(rig.runtime)
    const issued: string[] = []
    vi.spyOn(rig.runtime, 'applyLayoutCommand').mockImplementation(async (command, run) => {
      if (command.type === 'openAgentSessionTab') {
        issued.push(command.sessionId)
        if (command.sessionId === B) {
          entered.resolve()
          await finish.promise
        }
      }
      return apply(command, run)
    })
    const restore = release()
    await entered.promise
    await closeStructuredAgentSessionChild(second, { runtime: rig.runtime })
    await closeStructuredAgentSessionChild(B, { runtime: rig.runtime })
    if (reopened) {
      await rig.runtime.publishStructuredAgentSessionTab({
        workspaceId: rig.workspace,
        sessionId: B,
        agent: 'codex',
        activate: true
      })
    }
    finish.resolve()
    await restore
    await chatTabCommandsSettled()
    expect(issued).toEqual([B])
    expect(savedIds(rig)).toEqual(reopened ? [B] : [])
    expect(rig.runtime.live(B)).toBe(reopened)
    expect(rig.runtime.live(second)).toBe(false)
    expect((await physicalReload(rig)).store.listVisibleSessionIds()).toEqual(reopened ? [B] : [])
  }
)

it('first orcad status imports legacy saved chats through install-first and admission reuse', async () => {
  const profile = await authorityProfile([G, B], { legacy: true })
  const runtime = new AuthorityRuntime(profile.profile)
  replaceSaved(profile, [])
  const rig = await openAuthorityRuntime(profile, runtime, true)
  expect(rig.host.deps.store).toBe(rig.store)
  const journals = vi.spyOn(journalFactory, 'openAgentSessionJournal')
  const emit = vi.fn()
  const abort = new AbortController()
  const dispatcher = new RpcDispatcher({
    runtime,
    methods: STRUCTURED_AGENT_SESSION_STATUS_METHODS
  })
  try {
    await dispatcher.dispatchStreaming(
      {
        id: 'first-orcad',
        authToken: 'token',
        method: 'agentSession.subscribeStatus',
        params: null
      },
      (raw) => emit(JSON.parse(raw)),
      {
        clientKind: 'runtime',
        clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
        signal: abort.signal
      }
    )
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          type: 'snapshot',
          sessions: [expect.objectContaining({ sessionId: B })]
        })
      })
    )
    expect(rig.store.listVisibleSessionIds()).toEqual([B])
    expect(journals).not.toHaveBeenCalled()
    expect(rig.acquire).not.toHaveBeenCalled()
  } finally {
    abort.abort()
  }
})

it('checked unreadable selection survives but raw unreadable and foreign saved rows do not establish membership', async () => {
  const raw = 'raw-unreadable-0006',
    foreign = 'foreign-chat-0007'
  const profile = await authorityProfile([G, B, raw], { legacy: true, records: [B, raw, foreign] })
  await editPersistedTestAgentSessionStore(root, (state) => {
    Object.assign(state.records[B].lease, { minimumNextFence: 'bad' })
    Object.assign(state.records[raw], { providerHandleChain: 'bad' })
    state.records[foreign].location.executionHostId = toSshExecutionHostId('foreign')
  })
  const remote = savedSnapshot(profile, [foreign], toSshExecutionHostId('foreign'))
  profile.profile.setWorkspaceSession(remote, toSshExecutionHostId('foreign'))
  const rig = await openAuthorityRuntime(profile)
  expect(rig.runtime.capturedSelection()).toEqual([G, B, raw])
  expect(
    rig.profile
      .getWorkspaceSession(toSshExecutionHostId('foreign'))
      .unifiedTabs?.[rig.workspace]?.find((tab) => tab.entityId === foreign)?.executionHostId
  ).toBe(toSshExecutionHostId('foreign'))
  expect(rig.store.isSessionUnreadable(B)).toBe(true)
  expect(rig.store.getConversation(B)).not.toBeNull()
  expect(rig.store.getConversation(raw)).toBeNull()
  await rig.runtime.restoreStructuredAgentSessionTabs()
  expect(rig.store.listVisibleSessionIds()).toEqual([B])
  expect(
    rig.profile
      .getWorkspaceSession('local')
      .unifiedTabs?.[rig.workspace]?.map((tab) => tab.entityId)
  ).toEqual([B, raw])
  expect(
    rig.profile
      .getWorkspaceSession(toSshExecutionHostId('foreign'))
      .unifiedTabs?.[rig.workspace]?.some((tab) => tab.entityId === foreign)
  ).toBe(true)
})

it('refused switched predicates and metadata preserve membership; a close/reopen can choose a custom ID', async () => {
  const rig = await openAuthorityRuntime(await authorityProfile())
  expect(await rig.store.setSwitchedSessionTabVisibility(B, 'own-tab', true, () => false)).toBe(
    false
  )
  await rig.store.setConversationName(B, 'still selected')
  expect(rig.store.getVisibleSessionTabIndex().present).toBe(true)
  await rig.store.setSessionTabVisibility(B, false)
  await rig.store.setSessionTabVisibility(B, true, 'own-tab')
  expect(rig.store.getSessionTabId(B)).toBe('own-tab')
  expect(rig.store.listVisibleSessionIds()).toEqual([B])
})

it('late reservation is retained and resolved by a genuine later visibility action', async () => {
  const rig = await openAuthorityRuntime(await authorityProfile([B], { records: [] }))
  await rig.runtime.restoreStructuredAgentSessionTabs()
  expect(rig.store.getVisibleSessionTabIndex().present).toBe(true)
  const now = 1_700_000_000_000
  await rig.store.reserveOwner({
    sessionId: B,
    provider: 'codex',
    location: {
      executionHostId: 'local',
      workspaceId: rig.workspace,
      workspaceKind: 'folder',
      wslDistro: null
    },
    accountHome: { variable: 'CODEX_HOME', path: root },
    expectedFence: null,
    spawnToken: 'late-reservation',
    claimKeyId: 'late-key',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'late',
      operationId: `${now}-00000000000000000000000000000001`,
      fingerprint: 'late-record'
    },
    now
  })
  expect(rig.store.getRecord(B)).not.toBeNull()
  expect(rig.store.getVisibleSessionTabIndex().present).toBe(true)
  expect(await createC(rig, false)).toMatchObject({ ok: true })
  expect(rig.store.listVisibleSessionIds()).toEqual([B, C])
})

it.each([false, true])(
  'SQL COMMIT rejection adopts no authority or record, firstMessage=%s',
  async (first) => {
    const rig = await openAuthorityRuntime(await authorityProfile())
    const database = rig.host.deps.journalDatabase
    await failNativeJournalStatements(database, [
      { sql: 'COMMIT', message: 'commit rejected', visibility: true }
    ])
    expect(await createC(rig, first)).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_journal_unreadable' }
    })
    expect(rig.store.listVisibleSessionIds()).toEqual([B])
    expect(rig.store.getVisibleSessionTabIndex().present).toBe(true)
    expect(rig.store.getRecord(C)).toBeNull()
    await failNativeJournalStatements(database, [])
    expect(await createC(rig, first)).toMatchObject({ ok: true })
    expect(rig.store.listVisibleSessionIds()).toEqual([B, C])
    expect((await physicalReload(rig)).store.listVisibleSessionIds()).toEqual([B, C])
  }
)

it('captured close retires only its qualified workspace and preserves unrelated mirrors', async () => {
  const rig = await openAuthorityRuntime(await authorityProfile())
  await rig.host.setSessionTabVisibility(B, true)
  rig.runtime.projectStructuredAgentSessionTab({
    workspaceId: rig.workspace,
    sessionId: B,
    agent: 'codex',
    activate: true
  })
  const original = rig.runtime.mobileSessionTabsByWorktree.get(rig.workspace)!
  const duplicate = rig.profile.createFolderWorkspace({
    projectGroupId: rig.groupId,
    folderPath: `${root}/duplicate`,
    name: 'Duplicate'
  })
  const mirror = rig.profile.createFolderWorkspace({
    projectGroupId: rig.groupId,
    folderPath: `${root}/mirror`,
    name: 'Mirror',
    connectionId: 'foreign'
  })
  const duplicateKey = folderWorkspaceKey(duplicate.id),
    mirrorKey = folderWorkspaceKey(mirror.id)
  rig.runtime.storeMobileSessionSnapshot(duplicateKey, { ...original, worktree: duplicateKey })
  const foreign = rig.runtime.storeMobileSessionSnapshot(mirrorKey, {
    ...original,
    worktree: mirrorKey
  })
  await closeStructuredAgentSessionChild(B, { runtime: rig.runtime })
  expect(rig.runtime.mobileSessionTabsByWorktree.get(rig.workspace)?.tabs).toEqual([])
  expect(rig.runtime.mobileSessionTabsByWorktree.get(duplicateKey)?.tabs).toEqual(original.tabs)
  expect(rig.runtime.mobileSessionTabsByWorktree.get(mirrorKey)).toBe(foreign)
  expect(rig.runtime.retireStructuredAgentSessionTabFromSnapshot(B)).toBe(false)
  expect(rig.runtime.mobileSessionTabsByWorktree.get(mirrorKey)).toBe(foreign)
})

it('read-only ordinary reveal remains live through held startup without promising new durable visibility', async () => {
  const profile = await authorityProfile([B], { visible: [] })
  await seedTestAgentSessionStoreFromNewerBuild(root)
  const rig = await openAuthorityRuntime(profile)
  expect(rig.store.readOnly).toBe(true)
  const release = await holdStartup(rig)
  const dispatcher = new RpcDispatcher({
    runtime: rig.runtime,
    methods: STRUCTURED_AGENT_SESSION_REVEAL_METHODS
  })
  expect(
    await dispatcher.dispatch(
      {
        id: 'read-only-reveal',
        authToken: 'token',
        method: 'agentSession.reveal',
        params: { sessionId: B }
      },
      { clientKind: 'runtime', clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY] }
    )
  ).toMatchObject({ ok: true, result: { ok: true, readable: false } })
  expect(rig.runtime.live(B)).toBe(true)
  await release()
  expect(rig.store.listVisibleSessionIds()).toEqual([])
  expect(savedIds(rig)).toEqual([B])
  expect(rig.runtime.live(B)).toBe(true)
  expect(rig.acquire).not.toHaveBeenCalled()
})

it.each([false, true])(
  'caller-issued surface survives saved layout, hydration and physical restart; main=%s',
  async (main) => {
    layoutOwner.main = main
    const rig = await openAuthorityRuntime(
      await authorityProfile([B, C], { visible: [C], records: [B, C] })
    )
    await rig.runtime.restoreStructuredAgentSessionTabs()
    await chatTabCommandsSettled()
    const rpc = new RpcDispatcher({
      runtime: rig.runtime,
      methods: STRUCTURED_AGENT_SESSION_REVEAL_METHODS
    })
    const response = await rpc.dispatch(
      {
        id: 'reopen',
        authToken: 'token',
        method: 'agentSession.reveal',
        params: { sessionId: B, navigation: 'caller' }
      },
      {
        pairedDeviceId: 'phone',
        clientKind: 'mobile',
        clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
      }
    )
    expect(response).toMatchObject({ ok: true, result: { ok: true } })
    await chatTabCommandsSettled()
    const id = rig.store.getSessionTabId(B)!
    expect(id).toMatch(/^agent-chat-tab-v1-/)
    const saved = rig.profile.getWorkspaceSession('local')
    expect(
      saved.unifiedTabs?.[rig.workspace]?.filter((tab) => tab.entityId === B).map((tab) => tab.id)
    ).toEqual([id])
    expect(saved.tabGroups?.[rig.workspace]?.some((group) => group.activeTabId === id)).toBe(false)
    const currentSaved = rig.profile.getWorkspaceSession('local')
    const staleSaved = savedSnapshot(rig, [B, C])
    rig.profile.setWorkspaceSession(
      main
        ? windowViewSaveForMain(currentSaved, staleSaved, 'local')
        : windowSaveKeepingMainSleepRecords(currentSaved, staleSaved, 'set')
    )
    expect(rig.store.getSessionTabId(B)).toBe(id)
    await rig.runtime.publishStructuredAgentSessionTab({
      workspaceId: rig.workspace,
      sessionId: B,
      agent: 'codex',
      activate: false,
      navigation: 'caller'
    })
    await chatTabCommandsSettled()
    expect(
      rig.profile
        .getWorkspaceSession('local')
        .unifiedTabs?.[rig.workspace]?.filter((tab) => tab.entityId === B)
        .map((tab) => tab.id)
    ).toEqual([id])
    const fresh = await physicalReload(rig)
    expect(fresh.store.getSessionTabId(B)).toBe(id)
    const inventory = await fresh.runtime.listMobileSessionTabs(`id:${rig.workspace}`)
    expect(
      inventory.tabs
        .filter((tab) => tab.type === 'agent-session' && tab.sessionId === B)
        .map((tab) => tab.id)
    ).toEqual([id])
    expect(
      fresh.profile
        .getWorkspaceSession('local')
        .unifiedTabs?.[rig.workspace]?.filter((tab) => tab.entityId === B)
        .map((tab) => tab.id)
    ).toEqual([id])
  }
)

it('installs the cold host before looking up a persisted chat', async () => {
  const profile = await authorityProfile([B])
  const runtime = new AuthorityRuntime(profile.profile)
  const ensure = vi.spyOn(runtime, 'ensureStructuredAgentSessionHost')
  const rpc = new RpcDispatcher({ runtime, methods: ORCHESTRATION_CALLER_METHODS })
  const result = await rpc.dispatch(
    {
      id: 'cold-location',
      authToken: 'token',
      method: 'orchestration.partyLocation',
      params: { address: `orca_session_id:${B}` }
    },
    { clientKind: 'runtime', clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY] }
  )
  expect(ensure).toHaveBeenCalledOnce()
  expect(result).toMatchObject({
    ok: true,
    result: { location: { kind: 'chat', sessionId: B, worktreeId: profile.workspace } }
  })
})

it('does not admit saved cleanup when the current presentation scope becomes unreadable', async () => {
  const rig = await openAuthorityRuntime(await authorityProfile([B]))
  await rig.runtime.restoreStructuredAgentSessionTabs()
  const surface = rig.runtime.captureStructuredAgentSessionPresentation(B)
  await rig.host.setSessionTabVisibility(B, false)
  expect(savedIds(rig)).toEqual([])
  vi.spyOn(rig.store, 'getConversation').mockImplementation(() => {
    throw new Error('record unreadable')
  })
  rig.runtime.removeCapturedStructuredSessionSavedTabs(B, surface.saved)
  await chatTabCommandsSettled()
  expect(savedIds(rig)).toEqual([])
})
