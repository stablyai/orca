import './rpc/unused-default-rpc-methods.test-fixture'
import { beforeEach, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './rpc/dispatcher'
import { STRUCTURED_AGENT_SESSION_REVEAL_METHODS } from './rpc/methods/structured-agent-session-reveal'
import {
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../shared/agent-session/agent-session-runtime-capabilities'
import {
  B,
  C,
  root,
  authorityProfile,
  openAuthorityRuntime,
  rejectVisibility,
  savedIds
} from './structured-agent-session-tab-authority.test-support'
import { structuredAgentSessionTabId } from '../../shared/agent-session/view/structured-agent-session-projection'
import { chatTabCommandsSettled } from './session-layout-apply.test-fixture'
import { discardStructuredWorkerSession } from './rpc/methods/orchestration-structured-worker-session'

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
  'strict known-empty startup commits one actual winner after a refused attempt and preserves it after publication failure; main=%s',
  async (main) => {
    layoutOwner.main = main
    const rig = await openAuthorityRuntime(await authorityProfile([], { records: [B] }))
    const rpc = new RpcDispatcher({
      runtime: rig.runtime,
      methods: STRUCTURED_AGENT_SESSION_REVEAL_METHODS
    })
    const reveal = () =>
      rpc.dispatch(
        {
          id: 'known-empty',
          authToken: 'token',
          method: 'agentSession.reveal',
          params: { sessionId: B, navigation: 'caller' }
        },
        {
          pairedDeviceId: 'p',
          clientKind: 'mobile',
          clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
        }
      )
    const allow = rejectVisibility(rig)
    expect(await reveal()).toMatchObject({ ok: false })
    expect(rig.store.getSessionTabId(B)).toBeNull()
    expect(rig.runtime.live(B)).toBe(false)
    allow()
    const publication = vi
      .spyOn(rig.runtime, 'reopenMobileSessionTabForClient')
      .mockReturnValueOnce(false)
    expect(await reveal()).toMatchObject({ ok: false })
    const winner = rig.store.getSessionTabId(B)
    expect(winner).toMatch(/^agent-chat-tab-v1-/)
    publication.mockRestore()
    expect(await Promise.all([reveal(), reveal()])).toMatchObject([{ ok: true }, { ok: true }])
    await chatTabCommandsSettled()
    expect(rig.store.getSessionTabId(B)).toBe(winner)
    expect(savedIds(rig)).toEqual([B])
    expect(rig.runtime.live(B)).toBe(true)
    expect(rig.acquire).not.toHaveBeenCalled()
  }
)

it('a valid failed hide retires captured raw presentation and stops through the production phone dispatcher', async () => {
  const { SESSION_TAB_METHODS } = await import('./rpc/methods/session-tabs')
  const rig = await openAuthorityRuntime(await authorityProfile([B], { visible: [B] }))
  await rig.runtime.restoreStructuredAgentSessionTabs()
  const stop = vi.spyOn(rig.host, 'close')
  const rpc = new RpcDispatcher({ runtime: rig.runtime, methods: SESSION_TAB_METHODS })
  rig.runtime.attachWindow(1)
  rig.runtime.markGraphReady(1)
  const allow = rejectVisibility(rig)
  const response = await rpc.dispatch(
    {
      id: 'failed-hide',
      authToken: 'token',
      method: 'session.tabs.close',
      params: { worktree: rig.workspace, tabId: `agent-session:${B}`, reason: 'user' }
    },
    {
      pairedDeviceId: 'q',
      clientKind: 'mobile',
      clientCapabilities: [
        STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
        CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
      ]
    }
  )
  expect(response.ok, JSON.stringify(response)).toBe(true)
  expect(response).toMatchObject({ ok: true, result: { closed: true } })
  expect(response).not.toHaveProperty('result.retirementConfirmed')
  expect(stop).toHaveBeenCalledWith(B, 'user-close')
  expect(rig.runtime.live(B)).toBe(false)
  expect(rig.store.getSessionTabId(B)).toBe(structuredAgentSessionTabId(B))
  allow()
})

it.each(['stop', 'discard', 'sweep'] as const)(
  'the actual %s consumer cannot erase a strict reopen during its provider wait',
  async (consumer) => {
    const rig = await openAuthorityRuntime(await authorityProfile([B], { visible: [B] }))
    await rig.runtime.restoreStructuredAgentSessionTabs()
    const entered = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>()
    vi.spyOn(rig.host, 'close').mockImplementationOnce(async () => {
      entered.resolve()
      await finish.promise
    })
    const { stopStructuredWorker } =
      await import('./rpc/methods/orchestration-structured-worker-lifecycle')
    const { closeStructuredSessionsForWorktree, createStructuredSweepProgress } =
      await import('./structured-session-worktree-teardown')
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    const progress = createStructuredSweepProgress([{ sessionId: B, agent: 'claude' }])
    const stopping =
      consumer === 'stop'
        ? stopStructuredWorker(
            {
              handle: 'structworker_lifetime',
              sessionId: B,
              agent: 'claude',
              paneKey: 'unused',
              processIncarnation: `structured:${B}`,
              worktreeId: rig.workspace,
              hostScope: { kind: 'local', hostId: 'local' }
            },
            rig.runtime
          )
        : consumer === 'discard'
          ? discardStructuredWorkerSession(B, rig.runtime)
          : closeStructuredSessionsForWorktree(progress, 1_800_000_060_000, {
              runtime: rig.runtime
            })
    await entered.promise
    await rig.host.setSessionTabVisibility(B, false)
    const rpc = new RpcDispatcher({
      runtime: rig.runtime,
      methods: STRUCTURED_AGENT_SESSION_REVEAL_METHODS
    })
    expect(
      await rpc.dispatch(
        {
          id: 'worker-reopen',
          authToken: 'token',
          method: 'agentSession.reveal',
          params: { sessionId: B, navigation: 'caller' }
        },
        {
          pairedDeviceId: 'p',
          clientKind: 'mobile',
          clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
        }
      )
    ).toMatchObject({ ok: true, result: { ok: true } })
    const successor = rig.store.getSessionTabId(B)
    expect(successor).toMatch(/^agent-chat-tab-v1-/)
    finish.resolve()
    const outcome = await stopping
    if (consumer === 'stop') {
      expect(outcome).toMatchObject({ stopped: true, closeAttempted: true })
    }
    if (consumer === 'sweep') {
      expect(progress).toMatchObject({ closed: 1, settled: 1, unstopped: [] })
    }
    await chatTabCommandsSettled()
    expect(rig.store.getSessionTabId(B)).toBe(successor)
    expect(
      (await rig.runtime.listMobileSessionTabs(rig.workspace)).tabs.map((tab) => tab.id)
    ).toContain(successor)
    expect(savedIds(rig)).toEqual([B])
  }
)

it('cancellation carries the actual create reservation across a held commit, never a later winning table row', async () => {
  layoutOwner.main = true
  const rig = await openAuthorityRuntime(await authorityProfile([], { records: [] }))
  await rig.runtime.restoreStructuredAgentSessionTabs()
  const { createTestParams, CREATE_TEST_CALLER } =
    await import('../native-chat/agent-session-wire/structured-agent-session-create-test-fixture')
  const { commitStructuredAgentSessionCreate } =
    await import('./rpc/methods/structured-agent-session-create')
  const {
    refusingStructuredAgentSessionCreatesClosedFirst,
    noteStructuredAgentSessionClose,
    resetStructuredAgentSessionClosesBeforeCreateForTests
  } = await import('./rpc/methods/structured-agent-session-close-before-create')
  const base = createTestParams(undefined, {
    accountHome: { variable: 'CODEX_HOME', path: `${root}/codex-home` }
  })
  const params = createTestParams(undefined, {
    ...base,
    location: { ...base.location, workspaceId: rig.workspace },
    surfaceTabId: 'create-reserved-tab',
    envelope: {
      ...base.envelope,
      sessionId: C,
      clientOperationId: `${Date.now()}-000000000000000000000000000000ca`
    }
  })
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>()
  const commit = rig.store.founding.commit.bind(rig.store.founding)
  vi.spyOn(rig.store.founding, 'commit').mockImplementationOnce(async (request) => {
    const result = await commit(request)
    entered.resolve()
    await finish.promise
    return result
  })
  const stop = vi.spyOn(rig.host, 'close')
  const create = refusingStructuredAgentSessionCreatesClosedFirst(
    async (_params: { envelope: { sessionId: string } }, _ctx, capture) =>
      commitStructuredAgentSessionCreate({
        runtime: rig.runtime,
        caller: CREATE_TEST_CALLER,
        prepared: {
          host: rig.host,
          attachParams: params,
          tab: { workspaceId: rig.workspace, agent: 'codex' },
          atRest: {}
        },
        activate: true,
        capture
      })
  )
  const creating = create(params, { runtime: rig.runtime })
  await Promise.race([
    entered.promise,
    creating.then((result) => {
      throw new Error(`create finished before commit: ${JSON.stringify(result)}`)
    })
  ])
  noteStructuredAgentSessionClose(C, true)
  await rig.host.setSessionTabVisibility(C, false)
  try {
    await rig.runtime.publishStructuredAgentSessionTab({
      workspaceId: rig.workspace,
      sessionId: C,
      agent: 'codex',
      activate: false,
      navigation: 'caller'
    })
  } finally {
    finish.resolve()
  }
  const successor = rig.store.getSessionTabId(C)
  expect(await creating).toMatchObject({
    ok: false,
    refusal: { code: 'agent_session_operation_invalid' }
  })
  expect(rig.store.getSessionTabId(C)).toBe(successor)
  expect(stop).not.toHaveBeenCalled()
  expect(rig.runtime.live(C)).toBe(true)
  resetStructuredAgentSessionClosesBeforeCreateForTests()
})

it('retires the actual legacy Retry presentation after a worker stop even when advisory show never committed', async () => {
  const rig = await openAuthorityRuntime(await authorityProfile([B], { visible: [] }))
  await rig.runtime.restoreStructuredAgentSessionTabs()
  const allow = rejectVisibility(rig)
  try {
    await rig.runtime.publishStructuredAgentSessionTab({
      workspaceId: rig.workspace,
      sessionId: B,
      agent: 'claude',
      activate: true
    })
    expect(rig.store.getSessionTabId(B)).toBeNull()
    expect(rig.runtime.live(B)).toBe(true)
    const { closeStructuredAgentSessionChild } =
      await import('./agent-session/structured-agent-session-close')
    expect(await closeStructuredAgentSessionChild(B, { runtime: rig.runtime })).toEqual({
      stopped: true,
      closeAttempted: true
    })
    expect(rig.runtime.live(B)).toBe(false)
  } finally {
    allow()
  }
})

it('captures an admitted but unsaved failed-SHOW open, then removes exactly that row after Stop', async () => {
  layoutOwner.main = true
  const { fixture } =
    await import('../persistence/loading-store/profile-state-delayed-authority-fixture')
  const { store: profile, authority } = await fixture()
  const { installFakeAppEnvironment } =
    await import('../../../config/scripts/vitest-host-ports-setup')
  const { initOrcaProfilePaths } = await import('../orca-profiles/profile-storage-paths')
  installFakeAppEnvironment({ getPath: () => root })
  initOrcaProfilePaths()
  const group = profile.createProjectGroup({
    name: 'Pending open',
    parentPath: root,
    connectionId: null,
    parentGroupId: null,
    createdFrom: 'manual'
  })
  const folder = profile.createFolderWorkspace({
    projectGroupId: group.id,
    folderPath: root,
    name: 'Chat'
  })
  const { folderWorkspaceKey } = await import('../../shared/workspace-scope')
  const workspace = folderWorkspaceKey(folder.id),
    groupId = group.id,
    folderId = folder.id
  const { seedTestAgentSessionRecordStore } =
    await import('./agent-session/records/agent-session-record-store-test-harness')
  const { agentSessionRecordFixture, agentSessionLeaseFixture } =
    await import('../../shared/agent-session/lifecycle/agent-session-record.test-fixture')
  const entry = agentSessionRecordFixture(
    agentSessionLeaseFixture({
      sessionId: B,
      ownerProcess: null,
      reservedSpawnToken: null,
      claimStatus: 'released'
    })
  )
  await seedTestAgentSessionRecordStore(root, {
    records: [{ ...entry, location: { ...entry.location, workspaceId: workspace } }],
    sessionTabs: []
  })
  const rig = await openAuthorityRuntime({ profile, workspace, groupId, folderId })
  await rig.runtime.restoreStructuredAgentSessionTabs()
  const gate = authority.pause()
  const holding = profile.runDurableMutation(() => {
    profile.updateSettings({ theme: 'dark' })
    return { value: undefined }
  })
  await gate.started.promise
  const allow = rejectVisibility(rig)
  try {
    await rig.runtime.publishStructuredAgentSessionTab({
      workspaceId: workspace,
      sessionId: B,
      agent: 'claude',
      activate: true
    })
    expect(rig.store.getSessionTabId(B)).toBeNull()
    const captured = rig.runtime.captureStructuredAgentSessionPresentation(B)
    expect(captured.raw).toMatchObject({ tabId: `agent-session:${B}` })
    expect(captured.saved).toContainEqual({
      worktreeId: workspace,
      tabId: structuredAgentSessionTabId(B)
    })
    expect(savedIds(rig)).toEqual([])
    const { closeStructuredAgentSessionChild } =
      await import('./agent-session/structured-agent-session-close')
    expect(await closeStructuredAgentSessionChild(B, { runtime: rig.runtime })).toMatchObject({
      stopped: true
    })
    expect(rig.runtime.live(B)).toBe(false)
    gate.finish.resolve()
    await holding
    await vi.waitFor(() => expect(savedIds(rig)).toEqual([]))
    await chatTabCommandsSettled()
    expect(savedIds(rig)).toEqual([])
  } finally {
    gate.finish.resolve()
    await holding
    allow()
  }
})

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true]
] as const)(
  'a successful SHOW retired before publication stays obsolete and a new explicit open completes; main=%s caller=%s',
  async (main, caller) => {
    layoutOwner.main = main
    const { STRUCTURED_AGENT_SESSION_CLOSE_METHOD } =
      await import('./rpc/methods/structured-agent-session-close-method')
    const rig = await openAuthorityRuntime(
      await authorityProfile([], { records: [B], visible: [] })
    )
    await rig.runtime.restoreStructuredAgentSessionTabs()
    const rpc = new RpcDispatcher({
      runtime: rig.runtime,
      methods: [...STRUCTURED_AGENT_SESSION_REVEAL_METHODS, STRUCTURED_AGENT_SESSION_CLOSE_METHOD]
    })
    const options = {
      pairedDeviceId: 'p',
      clientKind: 'mobile' as const,
      clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
    }
    let closing: Promise<unknown> | undefined
    const visibility = rig.host.setSessionTabVisibility.bind(rig.host)
    const spy = vi
      .spyOn(rig.host, 'setSessionTabVisibility')
      .mockImplementation((id, visible, ...args) => {
        const result = visibility(id, visible, ...args)
        if (visible && !closing) {
          void result.then(() => {
            closing = STRUCTURED_AGENT_SESSION_CLOSE_METHOD.handler(
              { sessionId: B },
              {
                runtime: rig.runtime,
                clientKind: 'mobile',
                clientCapabilities: options.clientCapabilities
              }
            )
          })
        }
        return result
      })
    const reveal = () =>
      rpc.dispatch(
        {
          id: 'race',
          authToken: 'token',
          method: 'agentSession.reveal',
          params: { sessionId: B, ...(caller ? { navigation: 'caller' as const } : {}) }
        },
        options
      )
    expect(await reveal()).toMatchObject({ ok: false })
    expect(closing).toBeDefined()
    expect(await closing).toMatchObject({ ok: true })
    await chatTabCommandsSettled()
    expect(rig.store.getSessionTabId(B)).toBeNull()
    expect(rig.runtime.live(B)).toBe(false)
    expect(savedIds(rig)).toEqual([])
    spy.mockRestore()
    expect(await reveal()).toMatchObject({ ok: true, result: { ok: true } })
    await chatTabCommandsSettled()
    expect(rig.runtime.live(B)).toBe(true)
    expect(savedIds(rig)).toEqual([B])
    expect(rig.acquire).not.toHaveBeenCalled()
  }
)
