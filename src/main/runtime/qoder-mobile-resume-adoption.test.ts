import './rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import { buildAgentResumeStartupPlan } from '../../shared/tui-agent-startup'

await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
const { store, TEST_WORKTREE_PATH } = await import('./orca-runtime-test-fixtures.spec')
const { detectAgentCommandsOnHost } = await import('../preflight/agent-detection')

class QoderAdoptionRuntime extends OrcaRuntimeService {
  retainedRecipe(ptyId: string, worktreeId: string) {
    return this.recordPtyWorktree(ptyId, worktreeId)
  }
}

it.each([
  'client_disconnected',
  'Terminal creation timed out',
  'quoted-agent-command',
  'wsl-inventory',
  'changed-replay',
  'inventory-outage',
  'surviving-recipe'
])('reconciles a paired Qoder resume after ambiguous creation: %s', async (scenario) => {
  const failure = scenario === 'Terminal creation timed out' ? scenario : 'client_disconnected'
  const { withPlatform } = await import('./orca-runtime-test-fixtures.spec')
  await withPlatform(scenario === 'wsl-inventory' ? 'win32' : 'darwin', async () => {
    vi.useFakeTimers()
    try {
      const { electronMocks } = await import('./orca-runtime-test-mocks.spec')
      const { TEST_WORKTREE_ID } = await import('./orca-runtime-test-fixtures.spec')
      vi.mocked(detectAgentCommandsOnHost).mockResolvedValue(new Set(['qoder']))
      const runtime = new QoderAdoptionRuntime(store)
      runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
      let revealedRecipe: SleepingAgentLaunchConfig | undefined
      const revealTerminalSession = vi.fn(
        (_workspace: string, reveal: { launchConfig?: SleepingAgentLaunchConfig }) => {
          revealedRecipe = reveal.launchConfig
        }
      )
      runtime.setNotifier({
        focusTerminal: vi.fn(),
        worktreesChanged: vi.fn(),
        reposChanged: vi.fn(),
        activateWorktree: vi.fn(),
        createTerminal: vi.fn(),
        revealTerminalSession,
        splitTerminal: vi.fn(),
        renameTerminal: vi.fn(),
        closeTerminal: vi.fn(),
        closeSessionTab: vi.fn(),
        sleepWorktree: vi.fn(),
        terminalFitOverrideChanged: vi.fn(),
        terminalDriverChanged: vi.fn()
      })
      const acceptedCommands: string[] = []
      const live: {
        id: string
        cwd: string
        title: string
        worktreeId: string
        terminalHandle: string
        wslDistro?: string
      }[] = []
      let connection = new AbortController()
      let inventoryUnavailable = false
      const kill = vi.fn((id: string) => {
        const index = live.findIndex((entry) => entry.id === id)
        if (index !== -1) {
          live.splice(index, 1)
        }
        return true
      })
      const spawn = vi.fn(async (args: { command?: string; preAllocatedHandle?: string }) => {
        if (args.command) {
          acceptedCommands.push(args.command)
        }
        live.push({
          id: 'qoder-live-resume',
          cwd: TEST_WORKTREE_PATH,
          title: 'Qoder',
          worktreeId: TEST_WORKTREE_ID,
          terminalHandle: args.preAllocatedHandle ?? '',
          ...(scenario === 'wsl-inventory' ? { wslDistro: 'Ubuntu-Orca' } : {})
        })
        if (scenario === 'surviving-recipe') {
          const retained = runtime.retainedRecipe('qoder-live-resume', TEST_WORKTREE_ID)
          retained.launchAgent = 'qoder'
          retained.launchConfig = {
            agentCommand: 'trusted-qoder',
            agentArgs: 'trusted args',
            agentEnv: { TRUSTED: 'retained' }
          }
        }
        if (failure === 'client_disconnected') {
          connection.abort()
        }
        throw new Error(failure)
      })
      runtime.setPtyController({
        spawn,
        listProcesses: async () => {
          if (inventoryUnavailable) {
            throw new Error('host offline')
          }
          return live
        },
        write: () => true,
        kill,
        getForegroundProcess: async () => null
      })
      const send = vi.fn((channel: string, payload: { command?: string }) => {
        if (channel === 'terminal:requestTabCreate') {
          if (payload.command) {
            acceptedCommands.push(payload.command)
          }
          if (failure === 'client_disconnected') {
            connection.abort()
          }
        }
      })
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send, setBackgroundThrottling: vi.fn() }
      })
      const plan = buildAgentResumeStartupPlan({
        agent: 'qoder',
        providerSession: { key: 'session_id', id: 'same-qoder-session' },
        cmdOverrides: {},
        platform: 'darwin',
        agentArgs: '--captured-option',
        ...(scenario === 'quoted-agent-command' ? { agentCommand: "'qodercli'" } : {})
      })
      expect(plan).not.toBeNull()
      if (!plan) {
        throw new Error('missing resume plan')
      }
      const resume = {
        command: plan.launchCommand,
        launchAgent: 'qoder' as const,
        launchConfig: { ...plan.launchConfig, agentEnv: { OWNED_RECIPE: 'original value' } },
        activate: false,
        select: false,
        navigation: 'caller' as const,
        clientNavigationId: 'paired-phone',
        clientMutationId: 'stable-resume-mutation'
      }
      const first = runtime
        .createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
          ...resume,
          signal: connection.signal
        })
        .then(
          () => null,
          (error: unknown) => error
        )
      await vi.advanceTimersByTimeAsync(10_001)
      expect(await first).toBeInstanceOf(Error)
      expect(kill).not.toHaveBeenCalled()
      connection = new AbortController()
      if (scenario === 'inventory-outage') {
        inventoryUnavailable = true
        await expect(
          runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
            ...resume,
            signal: connection.signal
          })
        ).rejects.toThrow('runtime_unavailable')
        inventoryUnavailable = false
      }
      const retryPromise = runtime
        .createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
          ...resume,
          ...(scenario === 'changed-replay'
            ? { launchConfig: { ...resume.launchConfig, agentEnv: { CHANGED: 'retry' } } }
            : {}),
          signal: connection.signal
        })
        .catch(() => null)
      await vi.advanceTimersByTimeAsync(10_001)
      const retry = await retryPromise
      expect(acceptedCommands).toHaveLength(1)
      expect(acceptedCommands[0]).toBe(
        scenario === 'quoted-agent-command'
          ? "qoder '--resume' 'same-qoder-session'"
          : "qoder '--captured-option' '--resume' 'same-qoder-session'"
      )
      expect(retry?.tab).toMatchObject({ ptyId: 'qoder-live-resume', launchAgent: 'qoder' })
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(send).not.toHaveBeenCalled()
      if (!retry) {
        throw new Error('missing adopted resume')
      }
      const pane = runtime.resolveTerminalPane(`${retry.tab.parentTabId}:${retry.tab.leafId}`)
      await runtime.focusTerminal(pane.handle)
      expect(revealTerminalSession).toHaveBeenCalledWith(
        TEST_WORKTREE_ID,
        expect.objectContaining({
          launchAgent: 'qoder',
          launchConfig:
            scenario === 'surviving-recipe'
              ? {
                  agentCommand: 'trusted-qoder',
                  agentArgs: 'trusted args',
                  agentEnv: { TRUSTED: 'retained' }
                }
              : expect.objectContaining({
                  agentCommand:
                    scenario === 'quoted-agent-command'
                      ? "'qodercli'"
                      : "qoder '--captured-option'",
                  agentArgs: plan.launchConfig.agentArgs,
                  agentEnv: { OWNED_RECIPE: 'original value' }
                })
        })
      )
      if (!revealedRecipe) {
        throw new Error('missing revealed recipe')
      }
      const relaunch = buildAgentResumeStartupPlan({
        agent: 'qoder',
        providerSession: { key: 'session_id', id: 'same-qoder-session' },
        cmdOverrides: { qoder: 'changed-default-command' },
        platform: 'darwin',
        agentCommand: revealedRecipe.agentCommand,
        agentArgs: revealedRecipe.agentArgs,
        agentEnv: revealedRecipe.agentEnv
      })
      if (!relaunch) {
        throw new Error('missing relaunch')
      }
      const restoredSpawn = vi.fn().mockResolvedValue({ id: 'intentional-restored-qoder' })
      runtime.setPtyController({
        spawn: restoredSpawn,
        write: () => true,
        kill,
        getForegroundProcess: async () => null
      })
      await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        command: relaunch.launchCommand,
        launchAgent: 'qoder',
        launchConfig: relaunch.launchConfig,
        env: relaunch.env,
        focus: false
      })
      expect(restoredSpawn).toHaveBeenCalledWith(
        expect.objectContaining({
          command:
            scenario === 'surviving-recipe'
              ? "trusted-qoder '--resume' 'same-qoder-session'"
              : acceptedCommands[0],
          env: expect.objectContaining(
            scenario === 'surviving-recipe'
              ? { TRUSTED: 'retained' }
              : { OWNED_RECIPE: 'original value' }
          )
        })
      )
      expect(kill).not.toHaveBeenCalled()
      if (scenario === 'wsl-inventory' && retry) {
        expect(
          runtime.resolveTerminalPane(`${retry.tab.parentTabId}:${retry.tab.leafId}`).hostPlatform
        ).toBe('linux')
      }
    } finally {
      vi.useRealTimers()
    }
  })
})

it.each(['missing-original', 'different-agent'])(
  'refuses unproven adopted launch recipe: %s',
  async (state) => {
    const { TEST_WORKTREE_ID } = await import('./orca-runtime-test-fixtures.spec')
    const { deriveRemoteRuntimeTerminalCreateHandle } =
      await import('./remote-runtime-terminal-create-identity')
    const handle = deriveRemoteRuntimeTerminalCreateHandle(
      'owned-phone',
      TEST_WORKTREE_ID,
      'unknown-operation'
    )
    const runtime = new QoderAdoptionRuntime(store)
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    const tabId = 'original-owned-tab'
    const leafId = '55555555-5555-4555-8555-555555555555'
    runtime.registerPty('unknown-owned-pty', TEST_WORKTREE_ID, null, {
      tabId,
      leafId,
      terminalHandle: handle,
      incarnationId: 'owned-prior-incarnation'
    })
    const retained = runtime.retainedRecipe('unknown-owned-pty', TEST_WORKTREE_ID)
    const originalPaneKey = retained.paneKey
    const originalOwnership = retained.runtimeSessionOwned
    if (state === 'different-agent') {
      retained.launchAgent = 'codex'
    }
    const spawn = vi.fn()
    const kill = vi.fn()
    runtime.setPtyController({
      spawn,
      kill,
      write: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'unknown-owned-pty',
          worktreeId: TEST_WORKTREE_ID,
          terminalHandle: handle,
          cwd: TEST_WORKTREE_PATH,
          title: 'Unknown'
        }
      ]
    })
    await expect(
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        command: 'qodercli --resume original',
        launchAgent: 'qoder',
        launchConfig: {
          agentCommand: "'qodercli'",
          agentArgs: '--guessed-retry',
          agentEnv: { GUESSED: 'not-authoritative' }
        },
        clientNavigationId: 'owned-phone',
        clientMutationId: 'unknown-operation',
        select: false
      })
    ).rejects.toThrow(
      state === 'different-agent' ? 'terminal_create_identity_conflict' : 'runtime_unavailable'
    )
    expect(spawn).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
    expect(retained.launchConfig).toBeNull()
    expect(retained.launchAgent).toBe(state === 'different-agent' ? 'codex' : null)
    expect(retained.launchToken).toBeNull()
    expect(retained.launchIncarnationId).toBeNull()
    expect(retained.tabId).toBe(tabId)
    expect(retained.paneKey).toBe(originalPaneKey)
    expect(retained.runtimeSessionOwned).toBe(originalOwnership)
    expect(runtime.resolveTerminalPane(`${tabId}:${leafId}`).handle).toBe(handle)
  }
)

it('releases abandoned dispatch capacity without guessing an expired live recipe', async () => {
  vi.useFakeTimers()
  try {
    const { TEST_WORKTREE_ID } = await import('./orca-runtime-test-fixtures.spec')
    const { deriveRemoteRuntimeTerminalCreateHandle } =
      await import('./remote-runtime-terminal-create-identity')
    vi.mocked(detectAgentCommandsOnHost)
      .mockReset()
      .mockResolvedValue(new Set(['qoder']))
    const runtime = new OrcaRuntimeService(store)
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    let accept = false
    const inventory: {
      id: string
      worktreeId: string
      terminalHandle: string
      cwd: string
      title: string
    }[] = []
    const spawn = vi.fn(async () => {
      if (accept) {
        return { id: 'fresh-after-expiry' }
      }
      throw new Error('abandoned-create')
    })
    const kill = vi.fn()
    runtime.setPtyController({
      spawn,
      kill,
      write: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => inventory
    })
    const request = {
      command: 'qodercli --resume original',
      launchAgent: 'qoder' as const,
      launchConfig: {
        agentCommand: 'qodercli',
        agentArgs: '--original',
        agentEnv: { ORIGINAL: 'owned' }
      },
      clientNavigationId: 'owned-phone',
      select: false
    }
    for (let index = 0; index < 4096; index++) {
      await runtime
        .createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
          ...request,
          clientMutationId: `abandoned-${index}`
        })
        .catch((error: unknown) => {
          if (!(error instanceof Error) || error.message !== 'abandoned-create') {
            throw error
          }
        })
    }
    accept = true
    await expect(
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        ...request,
        clientMutationId: 'fresh-mutation'
      })
    ).rejects.toThrow('runtime_unavailable')
    expect(spawn).toHaveBeenCalledTimes(4096)
    await vi.advanceTimersByTimeAsync(14 * 60_000)
    await expect(
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        ...request,
        clientMutationId: 'fresh-mutation'
      })
    ).rejects.toThrow('runtime_unavailable')
    expect(spawn).toHaveBeenCalledTimes(4096)
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    const fresh = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      ...request,
      clientMutationId: 'fresh-mutation'
    })
    expect(fresh.tab.ptyId).toBe('fresh-after-expiry')
    inventory.push({
      id: 'expired-live-pty',
      worktreeId: TEST_WORKTREE_ID,
      terminalHandle: deriveRemoteRuntimeTerminalCreateHandle(
        'owned-phone',
        TEST_WORKTREE_ID,
        'abandoned-0'
      ),
      cwd: TEST_WORKTREE_PATH,
      title: 'Qoder'
    })
    await expect(
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        ...request,
        launchConfig: { ...request.launchConfig, agentEnv: { GUESSED: 'retry' } },
        clientMutationId: 'abandoned-0'
      })
    ).rejects.toThrow('runtime_unavailable')
    expect(spawn).toHaveBeenCalledTimes(4097)
    expect(kill).not.toHaveBeenCalled()
    expect(inventory).toHaveLength(1)
  } finally {
    vi.useRealTimers()
  }
}, 30_000)
