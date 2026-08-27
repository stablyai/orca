import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { RpcDispatcher } from './rpc/dispatcher'
import { STRUCTURED_AGENT_SESSION_METHODS } from './rpc/methods/structured-agent-session'
import {
  MOCK_GIT_WORKTREES,
  OrcaRuntimeService,
  listWorktrees,
  listWorktreesSharedStrict,
  listWorktreesStrict
} from './orca-runtime-test-mocks.spec'
import { TEST_WORKTREE_ID, TEST_WORKTREE_PATH, store } from './orca-runtime-test-fixtures.spec'

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

beforeEach(() => {
  vi.mocked(listWorktrees).mockResolvedValue(MOCK_GIT_WORKTREES)
  vi.mocked(listWorktreesSharedStrict).mockResolvedValue(MOCK_GIT_WORKTREES)
  vi.mocked(listWorktreesStrict).mockResolvedValue(MOCK_GIT_WORKTREES)
})
afterEach(async () => {
  await integratedHost?.flushAllStreamedEvents()
  if (integratedRoot) {
    await rm(integratedRoot, { recursive: true, force: true })
  }
  integratedHost = null
  integratedRoot = null
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
    const recordStore = await AgentSessionRecordStore.open({
      directory: join(integratedRoot, 'store'),
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
    vi.spyOn(runtime, 'getClientSettings').mockReturnValue({
      experimentalStructuredNativeChat: false,
      workItemStartPromptDelivery: 'submit-after-ready'
    } as never)
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
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: STRUCTURED_AGENT_SESSION_METHODS
    })
    let requestNumber = 0
    launchMocks.callRuntimeRpc.mockImplementation(async (_target, method, params) => {
      requestNumber += 1
      const response = await dispatcher.dispatch(
        {
          id: `work-item-${requestNumber}`,
          authToken: 'desktop-ipc',
          method,
          params
        },
        {
          clientId: 'desktop-renderer',
          clientKind: 'runtime',
          clientCapabilities: ['agent-session.structured.v1'],
          localDesktopAuthority: true
        }
      )
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
          number: 57,
          title: 'Start native Codex',
          url: 'https://github.com/acme/repo/issues/57'
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

    const result = await runtime.getWorktreePs()
    const summary = result.worktrees.find((entry) => entry.worktreeId === TEST_WORKTREE_ID)
    const sessionId = (sendCall[2] as { envelope: { sessionId: string } }).envelope.sessionId
    expect(summary?.agents).toEqual([
      expect.objectContaining({
        sessionId,
        providerSession: { key: 'session_id', id: 'work-item-thread' },
        agentType: 'codex',
        prompt: 'https://github.com/acme/repo/issues/57'
      })
    ])
    expect(summary?.agents).not.toEqual([])
    expect(summary?.agents[0]?.providerSession).not.toHaveProperty('transcriptPath')
    expect(recordStore.getRecord(sessionId)?.launchOrigin).toBe('work-item-start')
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
