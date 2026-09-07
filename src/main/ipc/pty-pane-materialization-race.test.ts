import { describe, expect, it, vi } from 'vitest'
import {
  wslUncDirectoryExistsAsyncMock,
  trackMock,
  getCodexPaneAccountMock
} from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { makePaneKey } from '../../shared/stable-pane-id'
import { registerPtyHandlers, getPtyIdForPaneKey, setLocalPtyProvider } from './pty'

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
  const { handlers, mainWindow, recoveredAgentClaim } = setupPtyIpcSuite()

  it('waits for an early runtime pane claim before renderer creation', async () => {
    type RuntimeSpawnController = {
      claimStablePaneCreate(args: {
        worktreeId: string
        connectionId: string | null
        tabId: string
        leafId: string
      }): () => void
    }
    const providerSpawn = vi.fn(async () => ({ id: 'pty-after-runtime-claim' }))
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
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_claimed'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }
    registerPtyHandlers(mainWindow as never, runtime as never)
    const tabId = 'tab-early-runtime-claim'
    const leafId = '44444444-4444-4444-8444-444444444444'
    const worktreeId = 'repo-1::/tmp/early-runtime-claim'
    const releaseClaim = (controller as unknown as RuntimeSpawnController).claimStablePaneCreate({
      worktreeId,
      connectionId: null,
      tabId,
      leafId
    })

    const mounted = handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd: '/tmp/early-runtime-claim',
      worktreeId,
      tabId,
      leafId,
      env: {
        ORCA_PANE_KEY: makePaneKey(tabId, leafId),
        ORCA_TAB_ID: tabId,
        ORCA_WORKTREE_ID: worktreeId
      }
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(providerSpawn).not.toHaveBeenCalled()

    releaseClaim()
    await expect(mounted).resolves.toMatchObject({ id: 'pty-after-runtime-claim' })
    expect(providerSpawn).toHaveBeenCalledOnce()
  })
  it('adopts a runtime reservation created during renderer preflight', async () => {
    type RuntimeSpawnController = {
      spawn(args: {
        cols: number
        rows: number
        command?: string
        sessionId?: string
        tabId: string
        leafId: string
        env: Record<string, string>
      }): Promise<{ id: string }>
    }
    let resolveProviderSpawn!: (result: { id: string }) => void
    const providerSpawn = vi.fn(
      () =>
        new Promise<{ id: string }>((resolve) => {
          resolveProviderSpawn = resolve
        })
    )
    setLocalPtyProvider({
      spawn: providerSpawn,
      write: vi.fn(),
      resize: vi.fn(),
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
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term-concurrent'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }
    let releaseAuth!: (value: {
      configDir: string
      envPatch: Record<string, never>
      stripAuthEnv: false
      provenance: string
    }) => void
    const prepareClaudeAuth = vi.fn(
      () =>
        new Promise<{
          configDir: string
          envPatch: Record<string, never>
          stripAuthEnv: false
          provenance: string
        }>((resolve) => {
          releaseAuth = resolve
        })
    )
    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      prepareClaudeAuth
    )
    const tabId = 'tab-mid-preflight-runtime'
    const leafId = '55555555-5555-4555-8555-555555555555'
    const paneKey = makePaneKey(tabId, leafId)
    const paneArgs = {
      cols: 80,
      rows: 24,
      sessionId: 'pty-runtime-reservation',
      tabId,
      leafId,
      env: { ORCA_PANE_KEY: paneKey }
    }

    const rendererSpawn = handlers.get('pty:spawn')!(null, {
      ...paneArgs,
      command: 'claude'
    })
    await vi.waitFor(() => expect(prepareClaudeAuth).toHaveBeenCalledOnce())

    const runtimeSpawn = (controller as unknown as RuntimeSpawnController).spawn({
      ...paneArgs,
      command: 'printf runtime'
    })
    await vi.waitFor(() => expect(providerSpawn).toHaveBeenCalledOnce())
    releaseAuth({
      configDir: '/tmp/claude',
      envPatch: {},
      stripAuthEnv: false,
      provenance: 'managed:test'
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    resolveProviderSpawn({ id: 'pty-runtime-reservation' })

    await expect(runtimeSpawn).resolves.toEqual({ id: 'pty-runtime-reservation' })
    await expect(rendererSpawn).resolves.toMatchObject({
      id: 'pty-runtime-reservation',
      isReattach: true
    })
    expect(providerSpawn).toHaveBeenCalledOnce()
    await expect(
      handlers.get('pty:getSize')!(null, { id: 'pty-runtime-reservation' })
    ).resolves.toEqual({ cols: 80, rows: 24 })
  })
  it('reuses renderer spawn when runtime materialization starts for the same pane', async () => {
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
    let registeredPane: { ptyId: string; tabId: string; leafId: string } | null = null
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_trusted'),
      preAllocateHandleForPty: vi.fn(() => 'term_trusted'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(
        (
          ptyId: string,
          _worktreeId: string,
          _connectionId: string | null,
          binding?: { tabId: string; leafId: string }
        ) => {
          if (binding) {
            registeredPane = { ptyId, ...binding }
          }
        }
      ),
      resolveTerminalPane: vi.fn(() => {
        if (!registeredPane) {
          throw new Error('terminal_not_found')
        }
        return {
          handle: 'term_trusted',
          tabId: registeredPane.tabId,
          leafId: registeredPane.leafId,
          ptyId: registeredPane.ptyId,
          worktreeId: 'repo-1::/tmp'
        }
      }),
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
    const leafId = '33333333-3333-4333-8333-333333333333'
    const paneKey = makePaneKey('tab-race', leafId)
    const rendererSpawn = handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      worktreeId: 'repo-1::/tmp',
      tabId: 'tab-race',
      leafId,
      env: {
        ORCA_PANE_KEY: paneKey,
        ORCA_TAB_ID: 'tab-race',
        ORCA_WORKTREE_ID: 'repo-1::/tmp'
      }
    }) as Promise<{ id: string }>
    await Promise.resolve()

    const spawnController = controller as unknown as RuntimeSpawnController
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
    await vi.waitFor(() => expect(providerSpawn).toHaveBeenCalledTimes(1))
    resolveSpawn({ id: 'pty-renderer' })
    const [rendererResult, runtimeResult] = await Promise.all([rendererSpawn, runtimeSpawn])
    expect(rendererResult).toEqual({ id: 'pty-renderer' })
    expect(runtimeResult).toEqual({
      id: 'pty-renderer',
      stablePaneOwner: {
        handle: 'term_trusted',
        tabId: 'tab-race',
        leafId
      }
    })
    expect(providerSpawn).toHaveBeenCalledTimes(1)
    expect(store.persistPtyBinding).toHaveBeenCalledWith({
      worktreeId: 'repo-1::/tmp',
      tabId: 'tab-race',
      leafId,
      ptyId: 'pty-renderer',
      startupCwd: '/tmp'
    })
  })
  it.each([
    {
      label: 'git worktree',
      worktreeId: 'repo-1::/tmp/live-owner',
      cwd: '/tmp/live-owner',
      paneAccountAtStart: { homeRoute: 'shared-home' },
      expectedHomeRouteAtStart: 'shared-home'
    },
    {
      label: 'folder workspace',
      worktreeId: 'folder:live-owner',
      cwd: '/tmp',
      paneAccountAtStart: null,
      expectedHomeRouteAtStart: null
    }
  ])(
    'adopts a completed runtime-owned pane before replacement launch preflight ($label)',
    async ({ worktreeId, cwd, paneAccountAtStart, expectedHomeRouteAtStart }) => {
      type StableAdoption = {
        result: { id: string; incarnationId?: string; isReattach?: boolean }
        owner: { handle?: string; tabId: string; leafId: string; ptyId: string }
        materialized?: true
      } | null
      type RuntimeSpawnController = {
        adoptStablePane(args: {
          cols: number
          rows: number
          worktreeId: string
          tabId: string
          leafId: string
          cwd: string
        }): Promise<StableAdoption>
        spawn(args: Record<string, unknown>): Promise<{
          id: string
          incarnationId?: string
          stablePaneOwner?: { handle: string; tabId: string; leafId: string }
        }>
      }
      const tabId = 'tab-live-owner'
      const leafId = '66666666-6666-4666-8666-666666666666'
      const paneKey = makePaneKey(tabId, leafId)
      let ownerPublished = false
      let releaseAttach!: () => void
      let attachBarrier: Promise<void>
      const resetAttachBarrier = (): void => {
        attachBarrier = new Promise<void>((resolve) => {
          releaseAttach = resolve
        })
      }
      resetAttachBarrier()
      const supportsAgentSessionClaims = vi.fn(async () => false)
      const supportsAgentSessionCreateOperations = vi.fn(async () => false)
      const providerSpawn = vi.fn(
        async (options: { attachOnly?: boolean; command?: string; sessionId?: string }) => {
          if (options.attachOnly) {
            await attachBarrier
            return {
              id: 'pty-live-owner',
              incarnationId: 'inc-live-owner',
              isReattach: true,
              snapshot: 'original-live-output',
              providerSequence: { value: 20, generation: 'continued' as const }
            }
          }
          return { id: 'pty-live-owner', incarnationId: 'inc-live-owner' }
        }
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
        supportsAgentSessionClaims,
        supportsAgentSessionCreateOperations,
        attach: vi.fn(),
        getDefaultShell: vi.fn(),
        getProfiles: vi.fn()
      } as never)
      const folderWorkspace = {
        id: 'live-owner',
        folderPath: cwd,
        projectGroupId: 'folder-group'
      }
      const store = {
        persistPtyBinding: vi.fn(),
        getFolderWorkspace: vi.fn(() => folderWorkspace),
        getFolderWorkspaces: vi.fn(() => [folderWorkspace]),
        getProjectGroups: vi.fn(() => []),
        getRepos: vi.fn(() => [])
      }
      const prepareClaudeAuth = vi.fn(() => {
        throw new Error('replacement auth preflight must not run')
      })
      const onCodexHomePtySpawned = vi.fn()
      let controller: RuntimeSpawnController | null = null
      const runtime = {
        setPtyController: vi.fn((value) => {
          controller = value
        }),
        resolveTerminalPane: vi.fn(() => {
          if (!ownerPublished) {
            throw new Error('terminal_not_found')
          }
          return {
            handle: 'term-live-owner',
            tabId,
            leafId,
            ptyId: 'pty-live-owner',
            worktreeId
          }
        }),
        createPreAllocatedTerminalHandle: vi.fn(() => 'term-provisional-renderer'),
        preAllocateHandleForPty: vi.fn(() => 'term-live-owner'),
        registerPreAllocatedHandleForPty: vi.fn(),
        beginPtyRegistration: vi.fn(),
        cancelPendingPtyRegistration: vi.fn(),
        assertPtyRegistrationAllowed: vi.fn(),
        registerPty: vi.fn(),
        noteTerminalSpawnCommand: vi.fn(),
        seedHeadlessTerminal: vi.fn(),
        onPtySpawned: vi.fn(),
        onPtyExit: vi.fn(),
        onPtyData: vi.fn()
      }

      registerPtyHandlers(
        mainWindow as never,
        runtime as never,
        undefined,
        undefined,
        prepareClaudeAuth,
        store as never,
        { onCodexHomePtySpawned }
      )
      const spawnController = controller as unknown as RuntimeSpawnController
      await spawnController.spawn({
        cols: 80,
        rows: 24,
        cwd,
        command: 'node original-agent-fixture.mjs',
        worktreeId,
        preAllocatedHandle: 'term-live-owner',
        tabId,
        leafId,
        env: { ORCA_PANE_KEY: paneKey },
        persistHostSessionBinding: true
      })
      ownerPublished = true
      runtime.createPreAllocatedTerminalHandle.mockClear()
      runtime.registerPreAllocatedHandleForPty.mockClear()
      runtime.noteTerminalSpawnCommand.mockClear()
      trackMock.mockClear()
      store.persistPtyBinding.mockClear()
      mainWindow.webContents.send.mockClear()

      wslUncDirectoryExistsAsyncMock.mockClear()
      const mountArgs = {
        cols: 120,
        rows: 40,
        cwd: '/a',
        cwdFallback: 'worktree',
        command: 'claude --resume provider-session',
        launchAgent: 'claude',
        worktreeId,
        projectRuntime: {
          status: 'resolved',
          runtime: {
            kind: 'wsl',
            hostPlatform: 'wsl',
            projectId: 'repo-1',
            distro: 'Ubuntu-24.04',
            reason: 'project-override',
            cacheKey: 'repo-1:wsl'
          }
        },
        tabId,
        leafId,
        env: {
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: tabId,
          ORCA_WORKTREE_ID: worktreeId
        },
        telemetry: {
          agent_kind: 'codex',
          launch_source: 'new_workspace_composer',
          request_kind: 'new'
        }
      }
      const firstMount = handlers.get('pty:spawn')!(null, mountArgs)
      await vi.waitFor(() => expect(providerSpawn).toHaveBeenCalledTimes(2))
      const secondMount = handlers.get('pty:spawn')!(null, mountArgs)
      releaseAttach()
      const [mounted, concurrentMounted] = await Promise.all([firstMount, secondMount])

      expect(mounted).toMatchObject({
        id: 'pty-live-owner',
        incarnationId: 'inc-live-owner',
        isReattach: true,
        snapshot: 'original-live-output'
      })
      expect(concurrentMounted).toEqual(mounted)
      expect(providerSpawn).toHaveBeenCalledTimes(2)
      expect(providerSpawn.mock.calls[1]?.[0]).toMatchObject({
        attachOnly: true,
        sessionId: 'pty-live-owner'
      })
      expect(providerSpawn.mock.calls[1]?.[0].command).toBeUndefined()
      expect(wslUncDirectoryExistsAsyncMock).not.toHaveBeenCalled()
      expect(runtime.createPreAllocatedTerminalHandle).not.toHaveBeenCalled()
      expect(prepareClaudeAuth).not.toHaveBeenCalled()
      expect(runtime.registerPreAllocatedHandleForPty).not.toHaveBeenCalled()
      expect(runtime.noteTerminalSpawnCommand).not.toHaveBeenCalled()
      expect(trackMock).not.toHaveBeenCalledWith('agent_started', expect.anything())
      expect(runtime.onPtyExit).not.toHaveBeenCalled()
      expect(getPtyIdForPaneKey(paneKey)).toBe('pty-live-owner')

      resetAttachBarrier()
      store.persistPtyBinding.mockClear()
      mainWindow.webContents.send.mockClear()
      const adoptionArgs = { cols: 120, rows: 40, cwd, worktreeId, tabId, leafId }
      let runtimeSecondAdoption: Promise<StableAdoption> | null = null
      runtime.beginPtyRegistration.mockImplementation(() => {
        runtimeSecondAdoption ??= spawnController.adoptStablePane(adoptionArgs)
      })
      getCodexPaneAccountMock.mockReturnValue(paneAccountAtStart)
      const rendererFirstMount = handlers.get('pty:spawn')!(null, mountArgs)
      await vi.waitFor(() => expect(providerSpawn).toHaveBeenCalledTimes(3))
      getCodexPaneAccountMock.mockReturnValue({ homeRoute: 'real-home' })
      releaseAttach()
      await vi.waitFor(() => expect(runtimeSecondAdoption).not.toBeNull())
      const pendingRuntimeAdoption = runtimeSecondAdoption
      if (!pendingRuntimeAdoption) {
        throw new Error('runtime adoption did not enter during renderer publication')
      }
      const adoptedOwner = await pendingRuntimeAdoption
      expect(adoptedOwner).toMatchObject({ materialized: true })

      const claimedResultPromise = spawnController.spawn({
        cols: 120,
        rows: 40,
        cwd,
        command: 'codex resume should-not-run',
        launchAgent: 'codex',
        worktreeId,
        preAllocatedHandle: 'term-live-owner',
        tabId,
        leafId,
        env: { ORCA_PANE_KEY: paneKey },
        persistHostSessionBinding: true,
        adoptedStablePane: adoptedOwner,
        agentSessionEnsure: {
          claim: {
            ...recoveredAgentClaim,
            identityDigest: 'ccccccccccccccccccccccccccccccccccccccccccc'
          },
          surface: { worktreeId, tabId, leafId, terminalHandle: 'term-live-owner' }
        },
        agentSessionCreateOperationId: 'create-op-must-not-run'
      })
      const [rendererFirstResult, claimedResult] = await Promise.all([
        rendererFirstMount,
        claimedResultPromise
      ])
      expect(rendererFirstResult).toMatchObject({
        id: 'pty-live-owner',
        incarnationId: 'inc-live-owner',
        isReattach: true
      })
      expect(onCodexHomePtySpawned).toHaveBeenCalledWith({
        id: 'pty-live-owner',
        codexHomePath: null,
        reattached: true,
        reattachedHomeRoute: expectedHomeRouteAtStart,
        startedAt: expect.any(Date),
        startedSequence: expect.any(Number)
      })
      expect(claimedResult).toMatchObject({
        id: 'pty-live-owner',
        stablePaneOwner: { handle: 'term-live-owner', tabId, leafId }
      })
      expect(providerSpawn).toHaveBeenCalledTimes(3)
      expect(supportsAgentSessionClaims).not.toHaveBeenCalled()
      expect(supportsAgentSessionCreateOperations).not.toHaveBeenCalled()
      expect(store.persistPtyBinding).toHaveBeenCalledOnce()
      expect(
        mainWindow.webContents.send.mock.calls.filter(([channel]) => channel === 'pty:spawned')
      ).toHaveLength(1)
    }
  )
})
