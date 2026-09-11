import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parsePairingCode } from '../../shared/pairing'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { RemoteRuntimeRequestConnection } from '../../shared/remote-runtime-request-connection'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { AgentSessionRecordStore } from './agent-session-record-store'
import {
  MOCK_GIT_WORKTREES,
  OrcaRuntimeService,
  listWorktrees,
  listWorktreesSharedStrict,
  listWorktreesStrict
} from './orca-runtime-test-mocks.spec'
import { TEST_WORKTREE_ID, TEST_WORKTREE_PATH, store } from './orca-runtime-test-fixtures.spec'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

const launchMocks = vi.hoisted(() => ({
  activateAndRevealWorktree: vi.fn(),
  callRuntimeRpc: vi.fn(),
  createWorktree: vi.fn(),
  ensureDetectedAgents: vi.fn(),
  refreshStructuredTabs: vi.fn(),
  toastError: vi.fn(),
  rendererStore: {} as Record<string, unknown>
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => launchMocks.rendererStore } }))
vi.mock('sonner', () => ({ toast: { error: launchMocks.toastError, message: vi.fn() } }))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: launchMocks.activateAndRevealWorktree
}))
vi.mock('@/lib/ensure-hooks-confirmed', () => ({
  ensureHooksConfirmed: vi.fn().mockResolvedValue('run')
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: () => ['agent-session.structured.v1'],
  refreshLocalRuntimeCapabilities: vi.fn().mockResolvedValue(['agent-session.structured.v1'])
}))
vi.mock('@/runtime/local-structured-session-tabs-sync', () => ({
  LOCAL_STRUCTURED_SESSION_OWNER: 'local',
  refreshLocalStructuredSessionTabs: launchMocks.refreshStructuredTabs
}))
vi.mock('@/runtime/runtime-hooks-client', () => ({
  checkRuntimeHooks: vi
    .fn()
    .mockResolvedValue({ hasHooks: false, hooks: null, mayNeedUpdate: false })
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: launchMocks.callRuntimeRpc,
  getActiveRuntimeTarget: () => ({ kind: 'local' }),
  runtimeEnvironmentSupportsCapability: vi.fn().mockResolvedValue(false)
}))
vi.mock('@/lib/new-workspace', () => ({
  CLIENT_PLATFORM: 'linux',
  getWorkspaceIntentName: (args: { workItem?: { number: number; title: string } | null }) =>
    args.workItem
      ? { displayName: `Issue ${args.workItem.number}`, seedName: `issue-${args.workItem.number}` }
      : null,
  getSetupConfig: () => null,
  getWorkspaceSeedName: ({ explicitName }: { explicitName?: string }) => explicitName ?? '',
  isGitLabIssueUrl: () => false
}))
vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))

await import('./orca-runtime-test-lifecycle.spec')

let integratedHost: StructuredAgentSessionHost | null = null
let integratedRoot: string | null = null
let integratedServer: OrcaRuntimeRpcServer | null = null
const integratedConnections: RemoteRuntimeRequestConnection[] = []

beforeEach(() => {
  vi.mocked(listWorktrees).mockResolvedValue(MOCK_GIT_WORKTREES)
  vi.mocked(listWorktreesSharedStrict).mockResolvedValue(MOCK_GIT_WORKTREES)
  vi.mocked(listWorktreesStrict).mockResolvedValue(MOCK_GIT_WORKTREES)
})
afterEach(async () => {
  for (const connection of integratedConnections.splice(0)) {
    connection.close()
  }
  await integratedServer?.stop()
  await integratedHost?.flushAllStreamedEvents()
  if (integratedRoot) {
    await rm(integratedRoot, { recursive: true, force: true })
  }
  integratedHost = null
  integratedRoot = null
  integratedServer = null
  setStructuredAgentSessionHost(null)
  vi.unstubAllGlobals()
})

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key)
    },
    setItem: (key, value) => {
      values.set(key, value)
    }
  }
}

function structuredAdapter(
  dispatch: StructuredAgentSessionAdapter['dispatch']
): StructuredAgentSessionAdapter {
  return {
    supportsCreate: () => true,
    acquire: async ({ fence, spawnToken }) => ({
      process: {
        hostId: 'local',
        pid: 4242,
        processStartTimeMs: 1_700_000_000_000,
        spawnToken
      },
      link: {
        linkId: `codex-${fence}-work-item-thread`,
        handle: { provider: 'codex', threadId: 'work-item-thread' },
        origin: 'created',
        mintedAtFence: fence,
        observedAt: Date.now()
      }
    }),
    releaseAcquisition: async () => true,
    dispatch,
    cancelTurn: async () => ({ cancelled: true }),
    answerPrompt: async () => undefined,
    setOption: async () => undefined,
    disposeSession: async () => true
  }
}

function rendererWorkItemStore(): Record<string, unknown> {
  return {
    repos: [{ id: 'repo-1', path: '/tmp/repo', displayName: 'Repo', addedAt: 1 }],
    activeRepoId: 'repo-1',
    activeWorktreeId: null,
    projects: [],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    activeTabIdByWorktree: {},
    activeTabTypeByWorktree: {},
    activeBrowserTabIdByWorktree: {},
    activeFileIdByWorktree: {},
    activeTabType: null,
    settings: {
      defaultTuiAgent: 'codex',
      disabledTuiAgents: [],
      agentCmdOverrides: {},
      experimentalNativeChat: false,
      experimentalStructuredNativeChat: false,
      openAgentTabsInChatByDefault: false
    },
    ensureDetectedAgents: launchMocks.ensureDetectedAgents,
    ensureRemoteDetectedAgents: launchMocks.ensureDetectedAgents,
    createWorktree: launchMocks.createWorktree,
    updateWorktreeMeta: vi.fn().mockResolvedValue(undefined),
    setSidebarOpen: vi.fn()
  }
}

describe('structured agent worktree.ps projection', () => {
  it('runs Work Item Start through one durable native writer and authoritative worktree.ps', async () => {
    vi.clearAllMocks()
    vi.stubGlobal('localStorage', memoryStorage())
    launchMocks.rendererStore = rendererWorkItemStore()
    launchMocks.ensureDetectedAgents.mockResolvedValue(['codex'])
    launchMocks.createWorktree.mockResolvedValue({
      worktree: { id: TEST_WORKTREE_ID, path: TEST_WORKTREE_PATH },
      setup: undefined
    })
    launchMocks.activateAndRevealWorktree.mockReturnValue({ primaryTabId: 'tab-1' })

    integratedRoot = await mkdtemp(join(tmpdir(), 'orca-work-item-start-integration-'))
    const recordStoreDirectory = join(integratedRoot, 'store')
    const recordStore = await AgentSessionRecordStore.open({
      directory: recordStoreDirectory,
      hostId: 'local'
    })
    const providerDispatch = vi.fn<StructuredAgentSessionAdapter['dispatch']>(async () => ({
      state: 'accepted',
      providerIdentity: {
        provider: 'codex',
        threadId: 'work-item-thread',
        turnId: 'turn-1',
        ordinal: 0
      }
    }))
    integratedHost = new StructuredAgentSessionHost({
      store: recordStore,
      adapter: structuredAdapter(providerDispatch),
      journalRoot: integratedRoot,
      claimKeyId: 'key-1',
      mintSpawnToken: () => 'spawn-work-item'
    })
    setStructuredAgentSessionHost(integratedHost)

    const runtime = new OrcaRuntimeService(store)
    let clientSettings: {
      experimentalStructuredNativeChat: boolean
      workItemStartPromptDelivery: 'draft' | 'submit-after-ready'
    } = {
      experimentalStructuredNativeChat: false,
      workItemStartPromptDelivery: 'submit-after-ready'
    }
    vi.spyOn(runtime, 'getClientSettings').mockImplementation(() => clientSettings as never)
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    vi.spyOn(runtime, 'resolveStructuredAgentSessionCreateIntent').mockImplementation(
      async (params) =>
        ({
          location: {
            executionHostId: 'local',
            wslDistro: null,
            workspaceId: TEST_WORKTREE_ID,
            workspaceKind: 'git-worktree'
          },
          provider: params.agent,
          agent: params.agent,
          accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
          runtimeKind: 'native'
        }) as never
    )
    vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
    integratedServer = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath: integratedRoot,
      enableWebSocket: true,
      wsPort: 0
    })
    await integratedServer.start()
    const offer = integratedServer.createPairingOffer({
      address: '127.0.0.1',
      name: 'web-structured-start',
      scope: 'runtime'
    })
    if (!offer.available) {
      throw new Error('pairing unavailable')
    }
    const pairing = parsePairingCode(offer.pairingUrl)
    if (!pairing) {
      throw new Error('invalid pairing')
    }
    vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({
      id: TEST_WORKTREE_ID,
      creatorProvenance: { kind: 'paired-device', deviceId: offer.deviceId }
    } as never)
    const connection = new RemoteRuntimeRequestConnection(pairing, [
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
    ])
    integratedConnections.push(connection)
    launchMocks.callRuntimeRpc.mockImplementation(async (_target, method, params) => {
      const response = await connection.request(method, params, 5_000)
      if (!response.ok) {
        throw Object.assign(new Error(response.error.message), { code: response.error.code })
      }
      return response.result
    })
    launchMocks.refreshStructuredTabs.mockImplementation(() => runtime.listAllMobileSessionTabs())
    const rendererLaunchPath = '../../renderer/src/lib/' + 'launch-work-item-direct'
    const { launchWorkItemDirect } = (await import(rendererLaunchPath)) as {
      launchWorkItemDirect: (args: Record<string, unknown>) => Promise<boolean>
    }

    await expect(
      launchWorkItemDirect({
        repoId: 'repo-1',
        launchSource: 'task_page',
        openModalFallback: vi.fn(),
        promptDelivery: 'submit-after-ready',
        item: {
          type: 'issue',
          number: 101,
          title: 'Start native Codex',
          url: 'https://github.com/acme/repo/issues/101'
        }
      })
    ).resolves.toBe(true)

    expect(launchMocks.createWorktree).toHaveBeenCalledOnce()
    expect(providerDispatch).toHaveBeenCalledOnce()
    const sendCall = launchMocks.callRuntimeRpc.mock.calls.find(
      ([, method]) => method === 'agentSession.send'
    )
    expect(sendCall).toBeDefined()
    if (!sendCall) {
      throw new Error('Work Item Start did not send a structured prompt')
    }
    const replay = await launchMocks.callRuntimeRpc(...sendCall)
    expect(replay).toMatchObject({ ok: true, replayed: true })
    expect(providerDispatch).toHaveBeenCalledOnce()

    const supportCall = launchMocks.callRuntimeRpc.mock.calls.find(
      ([, method]) => method === 'agentSession.createSupport'
    )
    const createCall = launchMocks.callRuntimeRpc.mock.calls.find(
      ([, method]) => method === 'agentSession.create'
    )
    if (!supportCall || !createCall) {
      throw new Error('Work Item Start did not create a structured session')
    }
    connection.close()
    clientSettings = {
      experimentalStructuredNativeChat: false,
      workItemStartPromptDelivery: 'draft'
    }
    const reconnected = new RemoteRuntimeRequestConnection(pairing, [
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
    ])
    integratedConnections.push(reconnected)
    await expect(reconnected.request(supportCall[1], supportCall[2], 5_000)).resolves.toMatchObject(
      {
        ok: true,
        result: { supported: true }
      }
    )
    await expect(reconnected.request(createCall[1], createCall[2], 5_000)).resolves.toMatchObject({
      ok: true,
      result: { ok: true, replayed: true }
    })
    expect(providerDispatch).toHaveBeenCalledOnce()

    const result = await runtime.getWorktreePs()
    const summary = result.worktrees.find((entry) => entry.worktreeId === TEST_WORKTREE_ID)
    const sessionId = (sendCall[2] as { envelope: { sessionId: string } }).envelope.sessionId
    expect(summary?.agents).toEqual([
      expect.objectContaining({
        sessionId,
        providerSession: { key: 'session_id', id: 'work-item-thread' },
        agentType: 'codex',
        prompt: 'https://github.com/acme/repo/issues/101'
      })
    ])
    expect(summary?.agents).not.toEqual([])
    expect(summary?.agents[0]?.providerSession).not.toHaveProperty('transcriptPath')
    expect(recordStore.getRecord(sessionId)).toMatchObject({
      launchOrigin: 'work-item-start',
      launchAuthority: { kind: 'paired-device', deviceId: offer.deviceId }
    })
    const reopenedStore = await AgentSessionRecordStore.open({
      directory: recordStoreDirectory,
      hostId: 'local'
    })
    expect(reopenedStore.getRecord(sessionId)?.launchAuthority).toEqual({
      kind: 'paired-device',
      deviceId: offer.deviceId
    })

    const otherOffer = integratedServer.createPairingOffer({
      address: '127.0.0.1',
      name: 'other-runtime',
      scope: 'runtime'
    })
    if (!otherOffer.available) {
      throw new Error('second pairing unavailable')
    }
    const otherPairing = parsePairingCode(otherOffer.pairingUrl)
    if (!otherPairing) {
      throw new Error('invalid second pairing')
    }
    const otherConnection = new RemoteRuntimeRequestConnection(otherPairing, [
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
    ])
    integratedConnections.push(otherConnection)
    await expect(
      otherConnection.request(
        'agentSession.createSupport',
        { worktree: `id:${TEST_WORKTREE_ID}`, agent: 'codex', launchOrigin: 'work-item-start' },
        5_000
      )
    ).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('structured_agent_session_unsupported') }
    })

    const mobileOffer = integratedServer.createPairingOffer({
      address: '127.0.0.1',
      name: 'mobile-client',
      scope: 'mobile'
    })
    if (!mobileOffer.available) {
      throw new Error('mobile pairing unavailable')
    }
    const mobilePairing = parsePairingCode(mobileOffer.pairingUrl)
    if (!mobilePairing) {
      throw new Error('invalid mobile pairing')
    }
    const mobileConnection = new RemoteRuntimeRequestConnection(mobilePairing, [
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
    ])
    integratedConnections.push(mobileConnection)
    await expect(
      mobileConnection.request(
        'agentSession.createSupport',
        { worktree: `id:${TEST_WORKTREE_ID}`, agent: 'codex', launchOrigin: 'work-item-start' },
        5_000
      )
    ).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('structured_agent_session_unsupported') }
    })
  })

  it('lists the authoritative structured session and provider identities', async () => {
    setStructuredAgentSessionHost({
      listStatusSummaries: () => [
        {
          sessionId: 'native-session-1',
          workspaceId: TEST_WORKTREE_ID,
          agent: 'codex',
          status: 'working',
          latestPrompt: 'Implement the task',
          providerSession: {
            key: 'session_id',
            id: 'codex-thread-1',
            transcriptPath: '/private/codex/thread-1.jsonl'
          },
          updatedAt: 1_000
        }
      ]
    } as never)
    const runtime = new OrcaRuntimeService(store)

    const result = await runtime.getWorktreePs()
    const summary = result.worktrees.find((entry) => entry.worktreeId === TEST_WORKTREE_ID)

    expect(summary).toMatchObject({ status: 'working', hasHostSidebarActivity: true })
    expect(summary?.agents).toEqual([
      expect.objectContaining({
        sessionId: 'native-session-1',
        providerSession: { key: 'session_id', id: 'codex-thread-1' },
        state: 'working',
        agentType: 'codex',
        prompt: 'Implement the task'
      })
    ])
    expect(summary?.agents[0]?.providerSession).toEqual({
      key: 'session_id',
      id: 'codex-thread-1'
    })
  })

  it('lists a newly attached structured session before its first turn', async () => {
    setStructuredAgentSessionHost({
      listStatusSummaries: () => [
        {
          sessionId: 'native-session-new',
          workspaceId: TEST_WORKTREE_ID,
          agent: 'codex',
          status: null,
          latestPrompt: '',
          updatedAt: 2_000
        }
      ]
    } as never)
    const runtime = new OrcaRuntimeService(store)

    const result = await runtime.getWorktreePs()
    const summary = result.worktrees.find((entry) => entry.worktreeId === TEST_WORKTREE_ID)

    expect(summary?.agents).toEqual([
      expect.objectContaining({
        sessionId: 'native-session-new',
        state: 'done',
        agentType: 'codex'
      })
    ])
  })

  it('projects an authoritative structured prompt as permission attention', async () => {
    setStructuredAgentSessionHost({
      listStatusSummaries: () => [
        {
          sessionId: 'native-session-attention',
          workspaceId: TEST_WORKTREE_ID,
          agent: 'claude',
          status: 'attention',
          latestPrompt: 'Review this change',
          updatedAt: 3_000
        }
      ]
    } as never)
    const runtime = new OrcaRuntimeService(store)

    const result = await runtime.getWorktreePs()
    const summary = result.worktrees.find((entry) => entry.worktreeId === TEST_WORKTREE_ID)

    expect(summary).toMatchObject({ status: 'permission', hasHostSidebarActivity: true })
    expect(summary?.agents).toEqual([
      expect.objectContaining({ sessionId: 'native-session-attention', state: 'blocked' })
    ])
  })
})
