import '../unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../../../shared/agent-launch-runtime-capability'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-create-capabilities'
import {
  createRestTestRig,
  type RestTestRig
} from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import { HOST_TEST_NOW } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { RpcContext } from '../core'
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
  await rig.dispose()
  vi.useRealTimers()
})

function launchRuntime(folder = false) {
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
    selectCreatedMobileSessionTabForClient: vi.fn(() => true),
    publishStructuredAgentSessionTab: vi.fn(async () => {})
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
  expect(rig.adapter.acquire.mock.calls.length > 0).toBe(startsAtCreation)
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

it('the opening prompt owns retry for a legacy-capability CLI caller', async () => {
  holdStarts()
  const result = await launch(CLI, 'fix the build')
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
