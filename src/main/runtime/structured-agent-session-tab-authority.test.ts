import './rpc/unused-default-rpc-methods.test-fixture'
import { beforeEach, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './rpc/dispatcher'
import { STRUCTURED_AGENT_SESSION_REVEAL_METHODS } from './rpc/methods/structured-agent-session-reveal'
import {
  seedTestAgentSessionStoreFromNewerBuild,
  editPersistedTestAgentSessionStore
} from './agent-session-record-store-test-harness'
import { STRUCTURED_AGENT_SESSION_STATUS_METHODS } from './rpc/methods/structured-agent-session-status-stream'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import { toSshExecutionHostId } from '../../shared/execution-host'
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
  savedIds
} from './structured-agent-session-tab-authority.test-support'
import { structuredAgentSessionTabId } from '../../shared/structured-agent-session-projection'
import { chatTabCommandsSettled } from './session-layout-apply.test-fixture'
import * as journalFactory from '../native-chat/agent-session-journal/journal-store-factory'
import { discardStructuredWorkerSession } from './rpc/methods/orchestration-structured-worker-session'
import { closeStructuredAgentSessionChild } from './agent-session/structured-agent-session-close'

// CLI capability probing is outside tab authority and must not start a real CLI in this fixture.
vi.mock('../claude/claude-cli-flag-prewarm', () => ({
  prewarmClaudeCliFlags: async () => undefined
}))

const layoutOwner = vi.hoisted(() => ({ main: false }))
vi.mock('../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.main
  }
}))
beforeEach(() => {
  layoutOwner.main = false
})

it.each([false, true])(
  'captures the initialized profile before mutable snapshot/lazy admission, firstMessage=%s',
  async (first) => {
    const profile = await authorityProfile([G, B])
    const runtime = new AuthorityRuntime(profile.profile)
    replaceSaved(profile, [])
    const rig = await openAuthorityRuntime(profile, runtime)
    expect(runtime.capturedSelection()).toEqual([G, B])
    expect(rig.host.deps.store).toBe(rig.store)
    expect(rig.host.getPersistedVisibleSessionTabIndex().present).toBe(false)
    const prepare = vi.spyOn(rig.store.founding, 'prepare')
    expect(await createC(rig, first)).toMatchObject({ ok: true })
    expect(prepare).toHaveBeenCalled()
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
  }
)

it.each([false, true])(
  'failed passive SQL and rejected hide do not spend the captured base, firstMessage=%s',
  async (first) => {
    const rig = await openAuthorityRuntime(await authorityProfile())
    const allow = rejectVisibility(rig)
    const release = await holdStartup(rig)
    expect(rig.host.getPersistedVisibleSessionTabIndex().present).toBe(false)
    replaceSaved(rig, [])
    await expect(rig.host.setSessionTabVisibility(B, false)).rejects.toThrow('visibility rejected')
    expect(savedIds(rig)).toEqual([])
    expect(rig.store.isSessionTabVisible(B)).toBe(true)
    await (first
      ? expect(createC(rig, first)).resolves.toMatchObject({ ok: false })
      : expect(createC(rig, first)).rejects.toThrow('visibility rejected'))
    expect(rig.store.getRecord(C)).toBeNull()
    expect(rig.host.getPersistedVisibleSessionTabIndex().present).toBe(false)
    allow()
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
    expect(rig.host.getPersistedVisibleSessionTabIndex().present).toBe(false)
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
    await rig.host.setSessionTabVisibility(B, false)
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

it('preserves a later explicit failed-show reopen and refreshes its snapshot-derived lookup', async () => {
  const rig = await openAuthorityRuntime(await authorityProfile())
  const release = await holdStartup(rig)
  await rig.host.setSessionTabVisibility(B, false)
  const allow = rejectVisibility(rig)
  await rig.runtime.publishStructuredAgentSessionTab({
    workspaceId: rig.workspace,
    sessionId: B,
    agent: 'codex',
    activate: true
  })
  expect(rig.store.isSessionTabVisible(B)).toBe(false)
  expect(rig.runtime.live(B)).toBe(true)
  await release()
  expect(savedIds(rig)).toContain(B)
  expect(rig.runtime.live(B)).toBe(true)
  const snapshot = rig.runtime.mobileSessionTabsByWorktree.get(rig.workspace)!
  rig.runtime.storeMobileSessionSnapshot(rig.workspace, { ...snapshot, tabs: [] })
  expect(rig.runtime.live(B)).toBe(false)
  rig.runtime.storeMobileSessionSnapshot(rig.workspace, snapshot)
  expect(rig.runtime.live(B)).toBe(true)
  rig.runtime.mobileSessionTabsByWorktree.delete(rig.workspace)
  expect(rig.runtime.live(B)).toBe(false)
  allow()
  await rig.host.setSessionTabVisibility(B, true)
  await rig.host.setSessionTabVisibility(B, false)
  await chatTabCommandsSettled()
  expect(savedIds(rig)).toEqual([])
})

it.each([false, true])(
  'retains exact known/null prior-ID rollback after unproven close, known=%s',
  async (known) => {
    const rig = await openAuthorityRuntime(await authorityProfile())
    if (known) {
      await rig.host.setSessionTabVisibility(B, true, 'known-tab')
    }
    await rig.store.transitionHandoff(B, (record) => ({
      ...record,
      lease: { ...record.lease, claimStatus: 'reserved', reservedSpawnToken: 'pending-owner' }
    }))
    vi.spyOn(rig.host, 'close').mockRejectedValueOnce(new Error('child close unproven'))
    const result = await closeStructuredAgentSessionChild(B, { runtime: rig.runtime })
    expect(result).toMatchObject({ stopped: false, closeAttempted: true })
    expect(rig.store.getSessionTabId(B)).toBe(known ? 'known-tab' : null)
    expect(rig.store.isSessionTabVisible(B)).toBe(known)
  }
)

it('failed worker discard explicitly restores a known tab instead of relying on a loaded handle', async () => {
  const rig = await openAuthorityRuntime(await authorityProfile())
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

it('leaves absence when no selected record is representable; rechecks raw selection on a genuine later action', async () => {
  const rig = await openAuthorityRuntime(await authorityProfile([G], { records: [] }))
  await rig.runtime.restoreStructuredAgentSessionTabs()
  expect(rig.store.getVisibleSessionTabIndex().present).toBe(false)
  expect(savedIds(rig)).toEqual([G])
  expect(rig.runtime.capturedSelection()).toEqual([G])
  expect(await createC(rig, false)).toMatchObject({ ok: true })
  expect(rig.store.listVisibleSessionIds()).toEqual([C])
})

it.each(['group', 'folder'] as const)(
  'keeps accepted %s removal and does not fabricate an owner from the captured base',
  async (kind) => {
    const rig = await openAuthorityRuntime(await authorityProfile())
    const allow = rejectVisibility(rig)
    const release = await holdStartup(rig)
    allow()
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
    vi.spyOn(rig.runtime, 'applyLayoutCommand').mockImplementation(async (command) => {
      if (command.type === 'openAgentSessionTab') {
        issued.push(command.sessionId)
        if (command.sessionId === B) {
          entered.resolve()
          await finish.promise
        }
      }
      return apply(command)
    })
    const restore = release()
    await entered.promise
    await rig.host.setSessionTabVisibility(second, false)
    await rig.host.setSessionTabVisibility(B, false)
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

it('first orcad status client uses the pre-snapshot capture through install-first and admission reuse', async () => {
  const profile = await authorityProfile([G, B])
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
  const profile = await authorityProfile([G, B, raw, foreign])
  await editPersistedTestAgentSessionStore(root, (state) => {
    Object.assign(state.records[B].lease, { minimumNextFence: 'bad' })
    Object.assign(state.records[raw], { providerHandleChain: 'bad' })
  })
  const saved = profile.profile.getWorkspaceSession('local')
  profile.profile.setWorkspaceSession({
    ...saved,
    unifiedTabs: Object.fromEntries(
      Object.entries(saved.unifiedTabs ?? {}).map(([key, tabs]) => [
        key,
        tabs.map((tab) =>
          tab.entityId === foreign
            ? { ...tab, executionHostId: toSshExecutionHostId('foreign') }
            : tab
        )
      ])
    )
  })
  const rig = await openAuthorityRuntime(profile)
  expect(rig.runtime.capturedSelection()).toEqual([G, B, raw])
  expect(
    rig.profile
      .getWorkspaceSession('local')
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
  ).toEqual([B, raw, foreign])
  expect(
    rig.profile
      .getWorkspaceSession('local')
      .unifiedTabs?.[rig.workspace]?.some((tab) => tab.entityId === foreign)
  ).toBe(true)
})

it('refused switched predicates and metadata consume no base; an own custom show overrides only its derived ID', async () => {
  const rig = await openAuthorityRuntime(await authorityProfile())
  expect(await rig.store.setSwitchedSessionTabVisibility(B, 'own-tab', true, () => false)).toBe(
    false
  )
  await rig.store.setConversationName(B, 'still selected')
  expect(rig.store.getVisibleSessionTabIndex().present).toBe(false)
  await rig.store.setSessionTabVisibility(B, true, 'own-tab')
  expect(rig.store.getSessionTabId(B)).toBe('own-tab')
  expect(rig.store.listVisibleSessionIds()).toEqual([B])
})

it('late reserved record is rechecked at the actual first visibility draft without reservation materialization', async () => {
  const rig = await openAuthorityRuntime(await authorityProfile([B], { records: [] }))
  await rig.runtime.restoreStructuredAgentSessionTabs()
  expect(rig.store.getVisibleSessionTabIndex().present).toBe(false)
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
  expect(rig.store.getVisibleSessionTabIndex().present).toBe(false)
  expect(await createC(rig, false)).toMatchObject({ ok: true })
  expect(rig.store.listVisibleSessionIds()).toEqual([B, C])
})

it.each([false, true])(
  'SQL COMMIT rejection adopts no authority or record, firstMessage=%s',
  async (first) => {
    const rig = await openAuthorityRuntime(await authorityProfile())
    const db = rig.host.deps.journalDatabase.db
    const exec = db.exec.bind(db)
    const failure = vi.spyOn(db, 'exec').mockImplementation((sql) => {
      if (
        sql === 'COMMIT' &&
        db
          .prepare("SELECT value FROM agent_session_store_meta WHERE key='session_tabs_recorded'")
          .get()
      ) {
        throw new Error('commit rejected')
      }
      return exec(sql)
    })
    await (first
      ? expect(createC(rig, first)).resolves.toMatchObject({ ok: false })
      : expect(createC(rig, first)).rejects.toThrow('commit rejected'))
    expect(rig.store.getVisibleSessionTabIndex().present).toBe(false)
    expect(rig.store.getRecord(C)).toBeNull()
    failure.mockRestore()
    expect(await createC(rig, first)).toMatchObject({ ok: true })
    expect(rig.store.listVisibleSessionIds()).toEqual([B, C])
  }
)

it('accepted hide retires every old local runtime row while preserving a foreign mirror', async () => {
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
  await rig.host.setSessionTabVisibility(B, false)
  expect(rig.runtime.mobileSessionTabsByWorktree.get(rig.workspace)?.tabs).toEqual([])
  expect(rig.runtime.mobileSessionTabsByWorktree.get(duplicateKey)?.tabs).toEqual([])
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
