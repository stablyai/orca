import { describe, expect, it, vi } from 'vitest'
import { spawnMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { makePaneKey } from '../../shared/stable-pane-id'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  registerPtyHandlers,
  clearProviderPtyState,
  setLocalPtyProvider,
  isCurrentPtyExit
} from './pty'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

describe('registerPtyHandlers', () => {
  const {
    handlers,
    mainWindow,
    createAgentClaimProvider,
    recoveredAgentClaim,
    recoveredAgentSurface
  } = setupPtyIpcSuite()

  it('does not update cached PTY size when runtime controller resize fails', async () => {
    type RuntimeResizeController = {
      spawn(args: { cols: number; rows: number }): Promise<{ id: string }>
      resize(ptyId: string, cols: number, rows: number): boolean
      getSize(ptyId: string): { cols: number; rows: number } | null
    }
    let controller: RuntimeResizeController | null = null
    const proc = {
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(() => {
        throw new Error('resize failed')
      }),
      kill: vi.fn(),
      process: 'zsh',
      pid: 12345
    }
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      }),
      preAllocateHandleForPty: vi.fn(),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      getDriver: vi.fn(() => ({ kind: 'host' })),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }
    spawnMock.mockReturnValue(proc)

    registerPtyHandlers(mainWindow as never, runtime as never)
    const resizeController = controller as unknown as RuntimeResizeController
    const spawned = await resizeController.spawn({ cols: 80, rows: 24 })

    expect(resizeController.resize(spawned.id, 120, 30)).toBe(false)
    expect(resizeController.getSize(spawned.id)).toEqual({ cols: 80, rows: 24 })
  })
  it('persists runtime-owned headless session bindings when explicitly requested', async () => {
    type RuntimeSpawnController = {
      spawn(args: {
        cols: number
        rows: number
        worktreeId?: string
        env?: Record<string, string>
        tabId?: string
        leafId?: string
        persistHostSessionBinding?: boolean
      }): Promise<{ id: string }>
    }
    const store = {
      persistPtyBinding: vi.fn()
    }
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_trusted'),
      preAllocateHandleForPty: vi.fn(() => 'term_trusted'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }

    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      undefined,
      store as never
    )
    const spawnController = controller as unknown as RuntimeSpawnController
    const leafId = '11111111-1111-4111-8111-111111111111'
    await spawnController.spawn({
      cols: 80,
      rows: 24,
      worktreeId: 'wt-1',
      tabId: 'tab-headless',
      leafId,
      env: { ORCA_PANE_KEY: makePaneKey('tab-headless', leafId) },
      persistHostSessionBinding: true
    })

    expect(store.persistPtyBinding).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'tab-headless',
      leafId,
      ptyId: expect.any(String),
      incarnationId: expect.any(String),
      hostAdmittedMembership: true
    })
  })
  it('shuts down a split PTY when its expected source binding was retired', async () => {
    type RuntimeSpawnController = {
      spawn(args: {
        cols: number
        rows: number
        worktreeId: string
        tabId: string
        leafId: string
        persistHostSessionBinding: boolean
        expectedSourceBinding: {
          worktreeId: string
          tabId: string
          leafId: string
          ptyId: string
        }
      }): Promise<{ id: string }>
    }
    const proc = {
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      process: 'zsh',
      pid: 12345
    }
    spawnMock.mockReturnValue(proc)
    const store = { persistPtyBinding: vi.fn(() => false) }
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      }),
      preAllocateHandleForPty: vi.fn(() => 'term_expected'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      undefined,
      store as never
    )
    const leafId = '22222222-2222-4222-8222-222222222222'
    const expectedSourceBinding = {
      worktreeId: 'wt-1',
      tabId: 'tab-headless',
      leafId: '11111111-1111-4111-8111-111111111111',
      ptyId: 'pty-source'
    }

    try {
      await expect(
        (controller as unknown as RuntimeSpawnController).spawn({
          cols: 80,
          rows: 24,
          worktreeId: 'wt-1',
          tabId: 'tab-headless',
          leafId,
          persistHostSessionBinding: true,
          expectedSourceBinding
        })
      ).rejects.toThrow('terminal_split_source_not_found')
    } finally {
      error.mockRestore()
    }

    expect(store.persistPtyBinding).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSourceBinding })
    )
    expect(proc.kill).toHaveBeenCalledOnce()
  })
  it('reports lower-owner commit before rejecting an early-exited runtime incarnation', async () => {
    const persistPtyBinding = vi.fn()
    const onPtySpawnCommitted = vi.fn()
    const runtime = new OrcaRuntimeService({
      getRepo: () => undefined,
      getRepos: () => [],
      addRepo: () => {},
      updateRepo: () => undefined as never,
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: () => undefined as never,
      removeWorktreeMeta: () => {},
      getGitHubCache: () => ({ pr: {}, issue: {} }) as never,
      getSettings: () => ({
        workspaceDir: '/tmp/workspaces',
        nestWorkspaces: false,
        refreshLocalBaseRefOnWorktreeCreate: false,
        branchPrefix: 'none',
        branchPrefixCustom: '',
        terminalMainSideEffectAuthority: true
      }),
      persistPtyBinding
    } as never)
    const provider = createAgentClaimProvider({
      spawn: vi.fn(async () => {
        runtime.onPtySpawned('pty-early-exit', 'incarnation-early-exit')
        runtime.onPtyExit('pty-early-exit', 0, 'incarnation-early-exit')
        return {
          id: 'pty-early-exit',
          incarnationId: 'incarnation-early-exit',
          providerSequence: { value: 17, generation: 'reset' as const },
          wslDistro: 'Ubuntu'
        }
      }),
      authoritativeOwnerListings: false
    })
    setLocalPtyProvider(provider as never)
    registerPtyHandlers(mainWindow as never, runtime, undefined, undefined, undefined, {
      persistPtyBinding
    } as never)
    const controller = (
      runtime as unknown as {
        ptyController: {
          spawn(args: Record<string, unknown>): Promise<unknown>
        }
      }
    ).ptyController
    const tabId = '11111111-1111-4111-8111-111111111111'
    const leafId = '22222222-2222-4222-8222-222222222222'

    await expect(
      controller.spawn({
        cols: 80,
        rows: 24,
        worktreeId: 'repo::/tmp/worktree',
        tabId,
        leafId,
        preAllocatedHandle: 'term_early_exit',
        persistHostSessionBinding: true,
        onPtySpawnCommitted
      })
    ).rejects.toThrow('agent_session_exited_during_start')

    expect(onPtySpawnCommitted).toHaveBeenCalledOnce()
    expect(persistPtyBinding).not.toHaveBeenCalled()
    const internals = runtime as unknown as {
      handleByPtyId: Map<string, string>
      providerSequenceInitializedPtys: Set<string>
      ptyOutputSequenceById: Map<string, number>
      ptysById: Map<string, { connected: boolean }>
      wslDistroByPtyId: Map<string, string>
      earlyExitedPtyIncarnations: Map<string, string | null>
    }
    expect(internals.handleByPtyId.has('pty-early-exit')).toBe(false)
    expect(internals.providerSequenceInitializedPtys.has('pty-early-exit')).toBe(false)
    expect(internals.ptyOutputSequenceById.has('pty-early-exit')).toBe(false)
    expect(internals.ptysById.get('pty-early-exit')?.connected).not.toBe(true)
    expect(internals.wslDistroByPtyId.has('pty-early-exit')).toBe(false)
    expect(internals.earlyExitedPtyIncarnations.has('pty-early-exit')).toBe(false)
    clearProviderPtyState('pty-early-exit')
  })
  it('does not retain a claimed owner when its PTY exits before controller admission', async () => {
    const runtime = new OrcaRuntimeService({
      getRepo: () => undefined,
      getRepos: () => [],
      addRepo: () => {},
      updateRepo: () => undefined as never,
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: () => undefined as never,
      removeWorktreeMeta: () => {},
      getGitHubCache: () => ({ pr: {}, issue: {} }) as never,
      getSettings: () => ({
        workspaceDir: '/tmp/workspaces',
        nestWorkspaces: false,
        refreshLocalBaseRefOnWorktreeCreate: false,
        branchPrefix: 'none',
        branchPrefixCustom: '',
        terminalMainSideEffectAuthority: true
      })
    } as never)
    const sessions: {
      id: string
      incarnationId: string
      cwd: string
      title: string
    }[] = []
    let attempt = 0
    const physicalSpawn = vi.fn(async () => {
      attempt += 1
      const incarnationId = attempt === 1 ? 'incarnation-exited' : 'incarnation-live'
      if (attempt === 1) {
        runtime.onPtySpawned('pty-claimed-admission', incarnationId)
        runtime.onPtyExit('pty-claimed-admission', 0, incarnationId)
      } else {
        sessions.push({
          id: 'pty-claimed-admission',
          incarnationId,
          cwd: '/tmp/worktree',
          title: 'Codex'
        })
      }
      return { id: 'pty-claimed-admission', incarnationId }
    })
    const provider = createAgentClaimProvider({
      sessions,
      spawn: physicalSpawn,
      authoritativeOwnerListings: false
    })
    Object.assign(provider, { routesFreshSpawnsToLocalProvider: true })
    setLocalPtyProvider(provider as never)
    registerPtyHandlers(mainWindow as never, runtime)
    const controller = (
      runtime as unknown as {
        ptyController: { spawn(args: Record<string, unknown>): Promise<unknown> }
      }
    ).ptyController
    const request = {
      cols: 80,
      rows: 24,
      cwd: '/tmp/worktree',
      agentSessionEnsure: {
        claim: recoveredAgentClaim,
        surface: recoveredAgentSurface
      }
    }

    await expect(controller.spawn(request)).rejects.toThrow('agent_session_exited_during_start')
    expect(
      isCurrentPtyExit({
        id: 'pty-claimed-admission',
        incarnationId: 'unrelated-incarnation'
      })
    ).toBe(true)
    await expect(controller.spawn(request)).resolves.toMatchObject({
      id: 'pty-claimed-admission',
      agentSessionEnsure: { disposition: 'created' }
    })
    expect(physicalSpawn).toHaveBeenCalledTimes(2)
    clearProviderPtyState('pty-claimed-admission')
  })
  it('reuses runtime materialization when renderer focuses the same pane during spawn', async () => {
    type RuntimeSpawnController = {
      spawn(args: {
        cols: number
        rows: number
        cwd?: string
        worktreeId?: string
        env?: Record<string, string>
        tabId?: string
        leafId?: string
        persistHostSessionBinding?: boolean
      }): Promise<{ id: string }>
    }
    let resolveSpawn!: (result: { id: string }) => void
    const providerSpawn = vi.fn(
      () =>
        new Promise<{ id: string }>((resolve) => {
          resolveSpawn = resolve
        })
    )
    setLocalPtyProvider({
      spawn: providerSpawn,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(async () => []),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)
    const store = {
      persistPtyBinding: vi.fn()
    }
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_trusted'),
      preAllocateHandleForPty: vi.fn(() => 'term_trusted'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }

    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      undefined,
      store as never
    )
    const spawnController = controller as unknown as RuntimeSpawnController
    const leafId = '22222222-2222-4222-8222-222222222222'
    const paneKey = makePaneKey('tab-race', leafId)
    const runtimeSpawn = spawnController.spawn({
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      worktreeId: 'repo-1::/tmp',
      tabId: 'tab-race',
      leafId,
      env: { ORCA_PANE_KEY: paneKey },
      persistHostSessionBinding: true
    })
    await Promise.resolve()

    // Why: SSH can strip ORCA_PANE_KEY before spawn; tab/leaf metadata must still dedupe against runtime materialization.
    const rendererSpawn = handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      worktreeId: 'repo-1::/tmp',
      tabId: 'tab-race',
      leafId,
      env: {
        ORCA_TAB_ID: 'tab-race',
        ORCA_WORKTREE_ID: 'repo-1::/tmp'
      }
    }) as Promise<{ id: string }>
    await Promise.resolve()

    expect(providerSpawn).toHaveBeenCalledTimes(1)
    resolveSpawn({ id: 'pty-shared' })
    await expect(Promise.all([runtimeSpawn, rendererSpawn])).resolves.toEqual([
      { id: 'pty-shared' },
      { id: 'pty-shared', isReattach: true }
    ])
    expect(providerSpawn).toHaveBeenCalledTimes(1)
    expect(store.persistPtyBinding).toHaveBeenCalledWith({
      worktreeId: 'repo-1::/tmp',
      tabId: 'tab-race',
      leafId,
      ptyId: 'pty-shared',
      startupCwd: '/tmp',
      hostAdmittedMembership: true
    })
  })
})
