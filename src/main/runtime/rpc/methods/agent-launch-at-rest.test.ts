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
import { methodNamed, rpcContext, runtimeStub } from './agent-launch.test-fixture'

vi.mock('../../../git/worktree-include-file', () => ({
  resolveWorktreeIncludePaths: vi.fn(async () => [])
}))
vi.mock('../../../git/worktree-shared-directories', () => ({
  resolveWorktreeSharedDirectories: vi.fn(async () => [])
}))

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
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
  setStructuredAgentSessionHost(rig.host)
})
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await closeTestStores()
  await rig.dispose()
  vi.useRealTimers()
})

function launch(caller: Partial<RpcContext>, prompt?: string) {
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
        workspaceKind: 'git-worktree'
      },
      provider: 'codex',
      agent: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/host/.codex' },
      options: { model: 'gpt-5.6-sol', effort: 'medium' },
      runtimeKind: 'native'
    })),
    publishStructuredAgentSessionTab: publisher.publishStructuredAgentSessionTab.bind(publisher)
  }
  const params = AGENT_LAUNCH.params.parse({
    agent: 'codex',
    target: { kind: 'existing', worktree: 'id:wt-7' },
    sessionId: SESSION,
    ...(prompt ? { prompt: { text: prompt, delivery: 'submit' } } : {})
  })
  return AGENT_LAUNCH.handler(params, rpcContext(runtime, caller))
}

it.each([
  { name: 'a bare launch from the phone waits', caller: PHONE, startsAtCreation: false },
  {
    name: 'a launch from the phone with a prompt starts',
    caller: PHONE,
    prompt: 'fix the build',
    startsAtCreation: true
  },
  { name: 'a bare launch from the CLI waits', caller: CLI, startsAtCreation: false }
])('$name', async ({ caller, prompt, startsAtCreation }) => {
  const result = await launch(caller, prompt)

  expect(result.outcome).toMatchObject({ kind: 'structured', sessionId: SESSION })
  expect(rig.store.getRecord(SESSION)).toBeDefined()
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
