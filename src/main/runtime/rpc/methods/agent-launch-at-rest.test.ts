import { join } from 'node:path'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { layoutApplyOn } from '../../session-layout-apply.test-fixture'
import '../unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../../../ipc/desktop-renderer-runtime-capabilities'
import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../../../shared/agent-launch-runtime-capability'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-create-capabilities'
import {
  createRestTestRig,
  type RestTestRig
} from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import { HOST_TEST_NOW } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { RpcContext } from '../core'
import type { RpcDispatchStreamingOptions } from '../dispatcher-stream-options'
import { RpcDispatcher } from '../dispatcher'
import { DESKTOP_RPC_CALLER } from '../rpc-caller-identity'
import { materializeRuntimeLocalWorktree } from '../../runtime-local-worktree-materialization'
import { createWorktreeCreateTimingRecorder } from '../../../worktree-create-timing'
import { Store } from '../../../persistence'
import {
  createSqliteTestStore,
  closeTestStores
} from '../../../persistence/persistence-test-harness'

import { AgentSessionPreSpawnError } from '../../../native-chat/agent-session-wire/structured-agent-session-adapter'
import { CodexAppServerRequestError } from '../../../codex/app-server/codex-app-server-request-error'
import { executeAgentLaunch } from '../../../agent-launch/agent-launch-executor'
import { agentLaunchSurfaceFactory } from './agent-launch-surfaces'
import * as structuredCreate from './structured-agent-session-create'
import {
  methodNamed,
  rpcContext,
  runtimeStub,
  setAgentLaunchRecordStore
} from './agent-launch.test-fixture'

vi.mock('../../../git/worktree-include-file', () => ({
  resolveWorktreeIncludePaths: vi.fn(async () => [])
}))
vi.mock('../../../git/worktree-shared-directories', () => ({
  resolveWorktreeSharedDirectories: vi.fn(async () => [])
}))

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const AGENT_LAUNCH_REPLAY = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')
const AGENT_LAUNCH = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')

// The phone: it renders either surface and sends a new chat's first message itself.
const PHONE: Partial<RpcContext> = {
  clientKind: 'mobile',
  pairedDeviceId: 'device-1',
  clientCapabilities: [
    AGENT_LAUNCH_RUNTIME_CAPABILITY,
    AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY
  ]
}
// The `orca` CLI carries no capability list.
const CLI: Partial<RpcContext> = {}
const SESSION = 'codex_9b1deb4d_3b7d_4bad_9bdd_2b0d7b3dcb6d'

let rig: RestTestRig
beforeEach(async () => {
  // The launch mints its operation id from the wall clock; the rig's host reads a fixed one.
  vi.useFakeTimers({ now: HOST_TEST_NOW, toFake: ['Date'] })
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  const acquire = rig.adapter.acquire.getMockImplementation()!
  rig.adapter.acquire.mockImplementation(async (input) => {
    const acquired = await acquire(input)
    return {
      ...acquired,
      link: {
        ...acquired.link!,
        origin: rig.store.getRecord(input.identity.sessionId)?.providerHandleChain.length
          ? 'resumed'
          : 'created'
      }
    }
  })
  setStructuredAgentSessionHost(rig.host)
  setAgentLaunchRecordStore(rig.store)
})
afterEach(async () => {
  setAgentLaunchRecordStore(null)
  setStructuredAgentSessionHost(null)
  await closeTestStores()
  await rig.dispose()
  vi.useRealTimers()
})

function launchRuntime(folder = false) {
  let session: WorkspaceSessionState = {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real ordinary publisher reads only these workspace layout methods in this fixture.
  const publisher = new OrcaRuntimeService({
    getRepos: () => [],
    getSettings: () => ({}),
    getWorkspaceSession: () => session,
    getWorkspaceSessionHostIds: () => ['local'],
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    },
    applyLayoutCommand: layoutApplyOn(
      () => session,
      (next) => {
        session = next
      }
    )
  } as never)
  const runtime = {
    ...runtimeStub(),
    resolveStructuredAgentSessionCreateIntent: vi.fn(async (params: { envelope: unknown }) => ({
      envelope: params.envelope,
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: folder ? 'folder' : 'git-worktree'
      },
      provider: 'codex',
      agent: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/host/.codex' },
      options: { model: 'gpt-5.6-sol', effort: 'medium' },
      runtimeKind: 'native'
    })),
    publishStructuredAgentSessionTab: publisher.publishStructuredAgentSessionTab.bind(publisher)
  }
  return runtime
}

function launch(caller: Partial<RpcContext>, prompt?: string, delivery = 'submit') {
  const params = AGENT_LAUNCH.params.parse({
    agent: 'codex',
    target: { kind: 'existing', worktree: 'id:wt-7' },
    sessionId: SESSION,
    ...(prompt ? { prompt: { text: prompt, delivery } } : {})
  })
  return AGENT_LAUNCH.handler(params, rpcContext(launchRuntime(), caller))
}

it.each([
  { name: 'a bare launch from the phone waits', caller: PHONE, startsAtCreation: false },
  {
    name: 'a draft launch keeps eager creation',
    caller: PHONE,
    prompt: 'fix the build',
    delivery: 'draft',
    startsAtCreation: true
  },
  { name: 'a bare launch from the CLI starts', caller: CLI, startsAtCreation: true }
])('$name', async ({ caller, prompt, delivery, startsAtCreation }) => {
  const result = await launch(caller, prompt, delivery)

  expect(result.outcome).toMatchObject({ kind: 'structured', sessionId: SESSION })
  expect(rig.store.getRecord(SESSION)).toBeDefined()
  expect(result.prompt).toEqual(
    prompt ? { delivery: 'draft', outcome: 'not-delivered' } : undefined
  )
  expect((await rig.host.journalSnapshot(SESSION)).submissions).toEqual([])
  // At rest, nothing is spawned until the chat's first message.
  if (startsAtCreation) {
    await vi.waitFor(() => expect(rig.adapter.acquire).toHaveBeenCalledOnce())
  } else {
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
  }
})

async function createThroughDispatcher(
  transport: RpcDispatchStreamingOptions,
  method: 'agent.launch' | 'agent.launchReplay' = 'agent.launch'
) {
  const store = createSqliteTestStore(Store, { dataFile: join(rig.root, 'profile', 'data.json') })
  const runtime = new OrcaRuntimeService(store)
  const { requireStore: _stubStore, ...stub } = runtimeStub()
  Object.assign(runtime, stub)
  vi.spyOn(runtime, 'openAgentSessionRecordStore').mockResolvedValue(rig.store)
  const repo = { id: 'repo-1', path: '/repo', displayName: 'Repo', badgeColor: 'blue', addedAt: 1 }
  const path = '/worktrees/task'
  const worktreeId = `${repo.id}::${path}`
  const create = vi.spyOn(runtime, 'createManagedWorktree').mockImplementation(async (request) => {
    const materialized = await materializeRuntimeLocalWorktree({
      request,
      repo,
      store,
      settings: store.getSettings(),
      created: { path, head: 'abc123', branch: 'task', isBare: false, isMainWorktree: false },
      remoteTrackingBase: null,
      sparseDirectories: [],
      checkoutExistingBranch: false,
      baseBranch: 'main',
      branchName: 'task',
      effectiveRequestedName: 'task',
      displayNameKind: request.displayNameKind,
      effectiveSanitizedName: 'task',
      effectiveCreatedWithAgent: 'claude',
      localWorktreeGitOptions: {},
      onMetadataPersisted: (worktree) => request.onWorkspaceCreated?.(worktree.id),
      timing: createWorktreeCreateTimingRecorder()
    })
    return { worktree: materialized.worktree }
  })
  vi.spyOn(runtime, 'resolveStructuredAgentSessionCreateIntent').mockImplementation(
    async (args): ReturnType<OrcaRuntimeService['resolveStructuredAgentSessionCreateIntent']> => ({
      envelope: {
        sessionId: args.envelope.sessionId,
        clientOperationId: args.envelope.clientOperationId,
        expectedRuntimeFence: null,
        payloadFingerprint: ''
      },
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: worktreeId,
        workspaceKind: 'git-worktree'
      },
      provider: 'claude',
      agent: 'claude',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(rig.root, 'claude') },
      options: {},
      runtimeKind: 'native'
    })
  )
  const dispatcher = new RpcDispatcher({ runtime, methods: AGENT_LAUNCH_METHODS })
  const response = await dispatcher.dispatch(
    {
      id: 'desktop-create',
      authToken: 'test',
      method,
      params: {
        ...(method === 'agent.launchReplay'
          ? {
              operationId: `${HOST_TEST_NOW}-ed37b034cd33408c9788c64aac5efe81`,
              createIdentity: { instanceId: 'db12a518-86d6-4146-9637-3398e7c08064' },
              paneKey: '71aed486-ccc7-4b8a-a232-804629f72176:e2473764-b614-42a3-9a61-8bf1df623db8'
            }
          : {}),
        agent: 'claude',
        sessionId: 'claude_7b92fa49_ba72_48b2_98e6_4045417b8cc5',
        surface: 'chat',
        sessionOptions: {},
        target: {
          kind: 'create-worktree',
          create: {
            repo: 'repo-1',
            name: 'task',
            setupDecision: 'run',
            nestWorkspaces: true,
            refreshLocalBaseRefOnWorktreeCreate: false
          }
        }
      }
    },
    transport
  )
  return { response, store, create, worktreeId }
}

it.each([
  {
    name: 'the host-stamped desktop with normal client metadata',
    method: 'agent.launchReplay',
    transport: {
      caller: DESKTOP_RPC_CALLER,
      clientId: 'desktop-renderer',
      clientKind: 'runtime',
      connectionId: 'desktop-1',
      clientCapabilities: DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES
    },
    creator: { kind: 'host' }
  },
  {
    name: 'a delegated phone acting for its paired desktop',
    method: 'agent.launch',
    transport: {
      clientKind: 'mobile',
      pairedDeviceId: 'phone-1',
      pairedDeviceParentId: 'parent-desktop',
      clientCapabilities: [AGENT_LAUNCH_RUNTIME_CAPABILITY]
    },
    creator: { kind: 'paired-device', deviceId: 'parent-desktop' }
  }
] satisfies {
  name: string
  method: 'agent.launch' | 'agent.launchReplay'
  transport: RpcDispatchStreamingOptions
  creator: unknown
}[])(
  'persists the actual creator and admits a no-prompt chat for $name',
  async ({ transport, creator, method }) => {
    const { response, store, create, worktreeId } = await createThroughDispatcher(transport, method)
    expect(response, JSON.stringify(response)).toMatchObject({
      ok: true,
      result: {
        worktreeId,
        outcome: { kind: 'structured', sessionId: 'claude_7b92fa49_ba72_48b2_98e6_4045417b8cc5' }
      }
    })
    expect(create).toHaveBeenCalledOnce()
    expect(store.getWorktreeMetaForHost(worktreeId, 'local')?.creatorProvenance).toEqual(creator)
    expect(
      rig.store.getRecord('claude_7b92fa49_ba72_48b2_98e6_4045417b8cc5')?.location.workspaceId
    ).toBe(worktreeId)
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
  }
)

it('refuses an unidentified declared runtime client before writing a workspace', async () => {
  const { response, store, create, worktreeId } = await createThroughDispatcher({
    clientId: 'unnamed-client',
    clientKind: 'runtime',
    connectionId: 'unidentified-1',
    clientCapabilities: [AGENT_LAUNCH_RUNTIME_CAPABILITY]
  })
  expect(response).toMatchObject({
    ok: false,
    error: { code: 'runtime_error', message: 'authenticated_device_identity_missing' }
  })
  expect(create).not.toHaveBeenCalled()
  expect(store.getWorktreeMetaForHost(worktreeId, 'local')).toBeUndefined()
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
})

it('refuses a paired phone without the negotiated launch capability before writing a workspace', async () => {
  const { response, store, create, worktreeId } = await createThroughDispatcher({
    clientKind: 'mobile',
    pairedDeviceId: 'phone-1',
    pairedDeviceParentId: 'parent-desktop',
    clientCapabilities: []
  })
  expect(response).toMatchObject({
    ok: false,
    error: { code: 'runtime_error', message: 'agent_launch_unsupported' }
  })
  expect(create).not.toHaveBeenCalled()
  expect(store.getWorktreeMetaForHost(worktreeId, 'local')).toBeUndefined()
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
})

async function child(sessionId = SESSION) {
  await vi.waitFor(() =>
    expect(rig.host.collaboratorsForTests().sessions.get(sessionId)?.child).toBeTruthy()
  )
  const current = rig.host.collaboratorsForTests().sessions.get(sessionId)!.child!
  if (!current.generation) {
    throw new Error('expected a published child')
  }
  return { sessionId, fence: current.fence, acquisitionGeneration: current.generation }
}

async function endChild(sessionId = SESSION) {
  const current = await child(sessionId)
  await rig.host.handleAdapterEvent({
    type: 'ended',
    ...current,
    reason: 'exited during initialize',
    cause: 'unexpected-exit'
  })
  await vi.waitFor(() =>
    expect(rig.host.collaboratorsForTests().sessions.get(sessionId)?.child).toBeNull()
  )
}

function holdStarts() {
  const acquire = rig.adapter.acquire.getMockImplementation()!
  rig.adapter.acquire.mockImplementation(rig.heldStart(acquire))
}

it('a whitespace-only submit creates an eager empty chat without sending a turn', async () => {
  const result = await launch(PHONE, ' \t\n ')
  expect(result.outcome).toMatchObject({ kind: 'structured', sessionId: SESSION })
  expect(result.prompt).toEqual({ delivery: 'submit', outcome: 'not-delivered' })
  expect(rig.adapter.acquire).toHaveBeenCalledOnce()
  expect((await rig.host.journalSnapshot(SESSION)).submissions).toEqual([])
  expect(rig.adapter.dispatch).not.toHaveBeenCalled()
})

it('the opening prompt owns retry with explicit model and permission for a legacy-capability CLI caller', async () => {
  holdStarts()
  const params = AGENT_LAUNCH.params.parse({
    agent: 'codex',
    target: { kind: 'existing', worktree: 'id:wt-7' },
    sessionId: SESSION,
    chatOptions: { model: 'explicit-model', permissionMode: 'full-access' },
    prompt: { text: 'fix the build', delivery: 'submit' }
  })
  const result = await AGENT_LAUNCH.handler(params, rpcContext(launchRuntime(), CLI))
  expect(result.prompt).toEqual({
    delivery: 'submit',
    outcome: 'journaled',
    messageId: expect.any(String)
  })
  expect((await rig.host.journalSnapshot(SESSION)).submissions).toMatchObject([
    {
      clientMessageId: result.prompt?.outcome === 'journaled' ? result.prompt.messageId : undefined,
      source: { kind: 'user' },
      dispatchState: 'pending'
    }
  ])
  await endChild()
  await vi.waitFor(() => expect(rig.adapter.acquire).toHaveBeenCalledTimes(2))
  await rig.proveStart(await child())
  await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledOnce())
  expect(rig.adapter.dispatch.mock.calls[0]?.[0].clientMessageId).toBe(
    result.prompt?.outcome === 'journaled' ? result.prompt.messageId : undefined
  )
  const snapshot = await rig.host.journalSnapshot(SESSION)
  expect(snapshot.submissions).toMatchObject([{ dispatchState: 'accepted' }])
  expect(snapshot.items.filter((item) => item.body.kind === 'status')).toEqual([])
  expect(rig.store.getRecord(SESSION)).toMatchObject({
    options: { model: 'explicit-model' },
    permissionMode: 'full-access'
  })
  expect(rig.store.getRecord(SESSION)?.options).not.toHaveProperty('effort')
})

it('rejects one requester with one failure row when all five children exit', async () => {
  holdStarts()
  const result = await launch(CLI, 'fix the build')
  for (let attempt = 1; attempt <= 5; attempt++) {
    await vi.waitFor(() => expect(rig.adapter.acquire).toHaveBeenCalledTimes(attempt))
    await endChild()
  }
  await vi.waitFor(async () =>
    expect((await rig.host.journalSnapshot(SESSION)).submissions).toMatchObject([
      {
        clientMessageId:
          result.prompt?.outcome === 'journaled' ? result.prompt.messageId : undefined,
        dispatchState: 'rejected'
      }
    ])
  )
  const snapshot = await rig.host.journalSnapshot(SESSION)
  expect(snapshot.submissions).toHaveLength(1)
  expect(
    snapshot.items.filter((item) => item.body.kind === 'status' && item.body.tone === 'error')
  ).toHaveLength(1)
  expect(rig.adapter.dispatch).not.toHaveBeenCalled()
})

it.each(['spawn', 'open'] as const)(
  'keeps a %s failure out of the accepted launch reply',
  async (stage) => {
    if (stage === 'spawn') {
      rig.adapter.acquire.mockRejectedValueOnce(
        new AgentSessionPreSpawnError(Object.assign(new Error('busy'), { code: 'EAGAIN' }))
      )
    } else {
      vi.spyOn(rig.host.deps.adapter, 'open').mockRejectedValueOnce(
        new CodexAppServerRequestError('initialize', -32603, 'temporarily unavailable')
      )
    }
    const result = await launch(CLI, 'fix the build')
    expect(result.prompt?.outcome).toBe('journaled')
    if (stage === 'spawn') {
      await vi.waitFor(async () =>
        expect((await rig.host.journalSnapshot(SESSION)).submissions).toMatchObject([
          { dispatchState: 'rejected' }
        ])
      )
      expect(rig.adapter.dispatch).not.toHaveBeenCalled()
      expect(rig.adapter.acquire).toHaveBeenCalledOnce()
    } else {
      await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledOnce())
      expect(rig.adapter.acquire).toHaveBeenCalledTimes(2)
    }
    expect((await rig.host.journalSnapshot(SESSION)).submissions).toHaveLength(1)
  }
)

it('replays a lost reply for a prompted folder launch without another message or child', async () => {
  const runtime = launchRuntime(true)
  const context = rpcContext(runtime, {
    clientKind: 'mobile',
    pairedDeviceId: 'old-phone',
    clientCapabilities: [AGENT_LAUNCH_RUNTIME_CAPABILITY]
  })
  const params = AGENT_LAUNCH_REPLAY.params.parse({
    agent: 'codex',
    target: { kind: 'existing', worktree: 'id:folder:fw-1' },
    sessionId: SESSION,
    operationId: `${HOST_TEST_NOW}-000000000000000000000000000000ee`,
    prompt: { text: 'fix the build', delivery: 'submit' },
    sessionOptions: {
      model: 'explicit-model',
      effort: 'high',
      serviceTier: 'fast',
      fastMode: 'true'
    }
  })
  const first = await AGENT_LAUNCH_REPLAY.handler(params, context)
  await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledOnce())
  const replay = await AGENT_LAUNCH_REPLAY.handler(params, context)
  expect(replay).toEqual(first)
  expect(first.prompt?.outcome).toBe('journaled')
  expect(runtime.resolveStructuredAgentSessionCreateIntent).toHaveBeenCalledOnce()
  expect(rig.adapter.acquire).toHaveBeenCalledOnce()
  expect(rig.store.getRecord(SESSION)?.options).toEqual({
    model: 'explicit-model',
    effort: 'high',
    serviceTier: 'fast'
  })
  expect((await rig.host.journalSnapshot(SESSION)).submissions).toHaveLength(1)
})

it.each([true, false])(
  'keeps an explicit Claude Fast %s over the opposite saved selection',
  async (fastMode) => {
    const runtime = launchRuntime()
    const resolve = runtime.resolveStructuredAgentSessionCreateIntent.getMockImplementation()!
    runtime.resolveStructuredAgentSessionCreateIntent.mockImplementation(async (params) => ({
      ...(await resolve(params)),
      provider: 'claude',
      agent: 'claude',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/host/.claude' },
      options: { model: 'claude-opus-4-6', effort: 'medium', fastMode: String(!fastMode) }
    }))
    const created = await agentLaunchSurfaceFactory(
      rpcContext(runtime, PHONE)
    ).createStructuredSession({
      worktreeId: 'wt-7',
      agent: 'claude',
      withoutPrompt: true,
      options: { model: 'claude-opus-4-6', fastMode }
    })
    expect(rig.store.getRecord(created.sessionId)?.options).toEqual({
      model: 'claude-opus-4-6',
      effort: 'medium',
      fastMode: String(fastMode)
    })
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
  }
)

it('omits unsupported-only Codex Fast overrides and retains saved defaults', async () => {
  const runtime = launchRuntime()
  const create = vi.spyOn(structuredCreate, 'createStructuredAgentSessionForWorktree')
  const created = await agentLaunchSurfaceFactory(
    rpcContext(runtime, PHONE)
  ).createStructuredSession({
    worktreeId: 'wt-7',
    agent: 'codex',
    withoutPrompt: true,
    options: { fastMode: true }
  })
  expect(create.mock.calls[0]?.[0]).not.toHaveProperty('options')
  expect(rig.store.getRecord(created.sessionId)?.options).toEqual({
    model: 'gpt-5.6-sol',
    effort: 'medium'
  })
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
  create.mockRestore()
})

it.each(['before', 'after'] as const)(
  'cancellation %s the create commit respects its receipt',
  async (when) => {
    holdStarts()
    const controller = new AbortController()
    const runtime = launchRuntime()
    const context = rpcContext(runtime, CLI)
    if (when === 'before') {
      const resolve = runtime.resolveStructuredAgentSessionCreateIntent.getMockImplementation()!
      runtime.resolveStructuredAgentSessionCreateIntent.mockImplementationOnce(async (input) => {
        controller.abort()
        return resolve(input)
      })
    } else {
      runtime.publishStructuredAgentSessionTab.mockImplementationOnce(async () =>
        controller.abort()
      )
    }
    const running = executeAgentLaunch({
      runtime,
      signal: controller.signal,
      surfaces: agentLaunchSurfaceFactory(context),
      intent: {
        agent: 'codex',
        sessionId: SESSION,
        target: { kind: 'existing', worktree: 'wt-7' },
        prompt: { text: 'keep my text', delivery: 'submit' }
      }
    })
    if (when === 'before') {
      await expect(running).rejects.toThrow('request_aborted')
      expect(rig.store.getRecord(SESSION)).toBeNull()
      expect(rig.adapter.acquire).not.toHaveBeenCalled()
      return
    }
    const result = await running
    expect(result.prompt?.outcome).toBe('journaled')
    await child()
    await rig.host.close(SESSION, 'user-close')
    await rig.host.revealSession(SESSION)
    const snapshot = await rig.host.journalSnapshot(SESSION)
    expect(snapshot.submissions).toMatchObject([
      {
        source: { kind: 'user' },
        keptAsQueuedMessageId:
          result.prompt?.outcome === 'journaled' ? result.prompt.messageId : undefined
      }
    ])
    expect(
      rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal.queuedMessages.list()
    ).toHaveLength(1)
    expect(rig.adapter.dispatch).not.toHaveBeenCalled()
  }
)

it('a tab publication failure after commit never calls the prompt undelivered', async () => {
  const runtime = launchRuntime()
  runtime.publishStructuredAgentSessionTab.mockRejectedValueOnce(
    new Error('publication unavailable')
  )
  await expect(
    AGENT_LAUNCH.handler(
      AGENT_LAUNCH.params.parse({
        agent: 'codex',
        sessionId: SESSION,
        target: { kind: 'existing', worktree: 'id:wt-7' },
        prompt: { text: 'keep my text', delivery: 'submit' }
      }),
      rpcContext(runtime, CLI)
    )
  ).rejects.toThrow()
  expect((await rig.host.journalSnapshot(SESSION)).submissions).toMatchObject([
    { source: { kind: 'user' }, dispatchState: 'pending' }
  ])
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
})
