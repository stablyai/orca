import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import { beginCreatedWorkspaceLaunch } from '../agent-launch/agent-launch-created-workspace'
import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../shared/agent-launch-runtime-capability'

const createStructured = vi.hoisted(() =>
  vi.fn(async (args: { envelope: { sessionId: string } }) => ({
    ok: true as const,
    value: { sessionId: args.envelope.sessionId }
  }))
)
vi.mock('./rpc/methods/structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: createStructured
}))

const {
  OrcaRuntimeService,
  computeWorktreePathMock,
  ensurePathWithinWorkspaceMock,
  getEffectiveHooks,
  getDefaultTabsLaunch,
  createSetupRunnerScript,
  listWorktrees
} = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { makeRuntimeStoreWithWorkspaceSession, store } =
  await import('./orca-runtime-test-fixtures.spec')

const DEFAULTS = {
  runCommands: true,
  tabs: [
    { title: 'Dev', command: 'pnpm dev' },
    { title: 'Tests', command: 'pnpm test' }
  ]
}

function chatCreateRuntime(args: {
  setupScriptLaunchMode: 'new-tab' | 'split-horizontal'
  withDefaults: boolean
  wait: boolean
  nativeChat?: true
}) {
  const path = '/tmp/workspaces/chat-create'
  const baseRepo = store.getRepo('repo-1')
  if (!baseRepo) {
    throw new Error('missing test repo')
  }
  const repo = {
    ...baseRepo,
    hookSettings: {
      mode: 'auto' as const,
      setupRunPolicy: 'run-by-default' as const,
      setupAgentStartupPolicy: args.wait
        ? ('wait-for-setup' as const)
        : ('start-immediately' as const),
      scripts: { setup: '', archive: '' }
    }
  }
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(getDefaultWorkspaceSession())
  const runtime = new OrcaRuntimeService({
    ...runtimeStore,
    getRepo: (id) => (id === repo.id ? repo : undefined),
    getRepos: () => [repo],
    getSettings: () => ({
      ...runtimeStore.getSettings(),
      setupScriptLaunchMode: args.setupScriptLaunchMode,
      ...(args.nativeChat ? { experimentalNativeChat: true } : {})
    })
  })
  const spawn = vi.fn<NonNullable<RuntimePtyController['spawn']>>(async () => {
    const ptyId = `pty-${spawn.mock.calls.length}`
    return { id: ptyId }
  })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  computeWorktreePathMock.mockReturnValue(path)
  ensurePathWithinWorkspaceMock.mockReturnValue(path)
  vi.mocked(getEffectiveHooks).mockReturnValue({ scripts: { setup: 'pnpm install' } })
  vi.mocked(getDefaultTabsLaunch).mockReturnValue(args.withDefaults ? DEFAULTS : undefined)
  vi.mocked(createSetupRunnerScript).mockReturnValue({
    runnerScriptPath: '/repo/setup.sh',
    envVars: {},
    ...(args.wait ? { waitForAgentStartup: true } : {})
  })
  vi.mocked(listWorktrees).mockResolvedValue([
    { path, head: 'abc', branch: 'chat-create', isBare: false, isMainWorktree: false }
  ])
  return { runtime, spawn }
}

describe('host-created workspaces awaiting their agent chat', () => {
  it.each([
    ['new-tab', false, false, false],
    ['new-tab', true, true, false],
    ['split-horizontal', false, false, false]
  ] as const)(
    'provisions only the required terminals (%s, defaults=%s, wait=%s, activate=%s)',
    async (setupScriptLaunchMode, withDefaults, wait, activate) => {
      const { runtime, spawn } = chatCreateRuntime({ setupScriptLaunchMode, withDefaults, wait })
      const launch = beginCreatedWorkspaceLaunch(runtime, 'claude')
      const result = await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'chat-create',
        createdWithAgent: 'claude',
        promisedAgentChat: true,
        onWorkspaceCreated: launch.onWorkspaceCreated,
        setupDecision: 'run',
        awaitTerminalProvisioning: true,
        observeSetupCompletion: true,
        activate
      })
      const commandCount = withDefaults ? 3 : 1
      expect(spawn).toHaveBeenCalledTimes(commandCount)
      expect(spawn.mock.calls.filter(([args]) => args.command === 'pnpm dev')).toHaveLength(
        withDefaults ? 1 : 0
      )
      expect(spawn.mock.calls.filter(([args]) => args.command === 'pnpm test')).toHaveLength(
        withDefaults ? 1 : 0
      )
      expect(result.setupReceipt).toMatchObject({
        state: 'running',
        startupPolicy: wait ? 'wait-for-setup' : 'start-immediately',
        terminalHandle: expect.any(String)
      })
      const snapshot = await runtime.listMobileSessionTabs(`id:${result.worktree.id}`)
      const query = await runtime
        .listMobileSessionTabs(`id:${result.worktree.id}`, undefined, {
          includeInitialSurfaceLaunch: true
        })
        .then((sampled) => {
          launch.release()
          return sampled
        })
      expect(query.initialSurfaceLaunch).toMatchObject({ agent: 'claude' })
      expect(snapshot.initialSurfaceLaunch).toBeUndefined()
      expect(
        (
          await runtime.listMobileSessionTabs(`id:${result.worktree.id}`, undefined, {
            includeInitialSurfaceLaunch: true
          })
        ).initialSurfaceLaunch
      ).toBeUndefined()
      expect(snapshot.tabs).toHaveLength(commandCount)
      if (!withDefaults) {
        expect(snapshot.tabs[0]?.title).toBe('Setup')
      }
    }
  )

  // The phone creates through agent.launch; a reported bug left a plain "Terminal 1" beside Setup.
  it('gives a paired-device chat launch Setup and the chat with no plain shell', async () => {
    const { runtime, spawn } = chatCreateRuntime({
      setupScriptLaunchMode: 'new-tab',
      withDefaults: false,
      wait: false,
      nativeChat: true
    })
    const { AGENT_LAUNCH_METHODS } = await import('./rpc/methods/agent-launch')
    const method = AGENT_LAUNCH_METHODS.find((entry) => entry.name === 'agent.launch')
    if (!method) {
      throw new Error('missing agent.launch')
    }
    const params = method.params.parse({
      agent: 'claude',
      target: {
        kind: 'create-worktree',
        create: { repo: 'id:repo-1', name: 'chat-create', setupDecision: 'run' }
      }
    })
    const result = await method.handler(params, {
      runtime,
      clientKind: 'mobile',
      pairedDeviceId: 'device-1',
      caller: { kind: 'paired-device', deviceId: 'device-1' },
      clientCapabilities: [AGENT_LAUNCH_RUNTIME_CAPABILITY]
    })

    expect(result.outcome).toMatchObject({ kind: 'structured' })
    expect(createStructured).toHaveBeenCalledOnce()
    expect(spawn).toHaveBeenCalledOnce()
    const tabs = (await runtime.listMobileSessionTabs(`id:${result.worktreeId}`)).tabs
    expect(tabs.map((tab) => tab.title)).toEqual(['Setup'])
  })
})
