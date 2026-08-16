import { describe, expect, it, vi } from 'vitest'
import { statSyncMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { TerminalSessionOwnerUnverifiedError } from '../daemon/daemon-errors'
import { makePaneKey } from '../../shared/stable-pane-id'
import { registerPtyHandlers, clearProviderPtyState, setLocalPtyProvider } from './pty'

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
  const { handlers, mainWindow } = setupPtyIpcSuite()

  it('repairs a stale persisted incarnation after exact same-id reattach', async () => {
    const tabId = 'tab-persisted-owner'
    const leafId = '88888888-8888-4888-8888-888888888888'
    const paneKey = makePaneKey(tabId, leafId)
    const worktreeId = 'repo-1::/tmp/persisted-owner'
    let attachAttempt = 0
    const providerSpawn = vi.fn(async (options: { attachOnly?: boolean; sessionId?: string }) => ({
      id: options.sessionId ?? 'unexpected-fresh-id',
      incarnationId: attachAttempt++ === 1 ? 'inc-wrong-owner' : 'inc-live-owner',
      isReattach: options.attachOnly === true,
      snapshot: 'persisted-owner-output'
    }))
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
    const runtime = {
      setPtyController: vi.fn(),
      resolveTerminalPane: vi.fn(() => {
        throw new Error('terminal_not_found')
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term-rebuilt-owner'),
      registerPreAllocatedHandleForPty: vi.fn(),
      beginPtyRegistration: vi.fn(),
      cancelPendingPtyRegistration: vi.fn(),
      assertPtyRegistrationAllowed: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      seedHeadlessTerminal: vi.fn(),
      onPtyExit: vi.fn()
    }
    const store = {
      getWorkspaceSession: vi.fn(() => ({
        tabsByWorktree: {
          [worktreeId]: [{ id: tabId, worktreeId, ptyId: 'pty-persisted-owner' }]
        },
        terminalLayoutsByTabId: {
          [tabId]: { ptyIdsByLeafId: { [leafId]: 'pty-persisted-owner' } }
        },
        terminalPtyIncarnationsByPaneKey: {
          [paneKey]: 'inc-stale-owner'
        }
      })),
      persistPtyBinding: vi.fn(() => true)
    }

    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      undefined,
      store as never
    )
    const spawnArgs = {
      cols: 80,
      rows: 24,
      cwd: '/tmp/persisted-owner',
      command: 'codex resume provider-session',
      worktreeId,
      tabId,
      leafId,
      env: {
        ORCA_PANE_KEY: paneKey,
        ORCA_TAB_ID: tabId,
        ORCA_WORKTREE_ID: worktreeId
      }
    }

    const mounted = await handlers.get('pty:spawn')!(null, spawnArgs)

    expect(mounted).toMatchObject({
      id: 'pty-persisted-owner',
      incarnationId: 'inc-live-owner',
      isReattach: true
    })
    expect(providerSpawn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        attachOnly: true,
        sessionId: 'pty-persisted-owner',
        expectedIncarnationId: 'inc-stale-owner',
        expectedIncarnationIsAuthoritative: false,
        command: undefined
      })
    )
    expect(runtime.registerPreAllocatedHandleForPty).toHaveBeenCalledWith(
      'pty-persisted-owner',
      'term-rebuilt-owner'
    )
    expect(runtime.noteTerminalSpawnCommand).not.toHaveBeenCalled()
    expect(store.persistPtyBinding).toHaveBeenCalledOnce()
    expect(store.persistPtyBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId,
        tabId,
        leafId,
        ptyId: 'pty-persisted-owner',
        incarnationId: 'inc-live-owner',
        expectedBinding: {
          ptyId: 'pty-persisted-owner',
          incarnationId: 'inc-stale-owner'
        }
      }),
      undefined
    )
    expect(
      mainWindow.webContents.send.mock.calls.filter(([channel]) => channel === 'pty:spawned')
    ).toHaveLength(1)
    expect(runtime.onPtyExit).not.toHaveBeenCalled()

    store.persistPtyBinding.mockClear()
    await expect(handlers.get('pty:spawn')!(null, spawnArgs)).rejects.toThrow(
      'terminal_pane_owner_changed'
    )
    expect(store.persistPtyBinding).not.toHaveBeenCalled()

    runtime.assertPtyRegistrationAllowed.mockImplementationOnce(() => {
      throw new Error('agent_session_exited_during_start')
    })
    await expect(handlers.get('pty:spawn')!(null, spawnArgs)).rejects.toThrow(
      'agent_session_exited_during_start'
    )
    expect(store.persistPtyBinding).not.toHaveBeenCalled()
    expect(providerSpawn).toHaveBeenCalledTimes(3)
    expect(providerSpawn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        attachOnly: true,
        sessionId: 'pty-persisted-owner',
        expectedIncarnationId: 'inc-live-owner',
        expectedIncarnationIsAuthoritative: true,
        command: undefined
      })
    )
    clearProviderPtyState('pty-persisted-owner')
  })
  it.each([
    {
      label: 'git worktree',
      worktreeId: 'repo-1::/tmp/dead-persisted-owner',
      cwd: '/tmp/dead-persisted-owner',
      folderMissing: false
    },
    {
      label: 'missing folder workspace',
      worktreeId: 'folder:dead-persisted-owner',
      cwd: '/tmp/missing-dead-persisted-owner',
      folderMissing: true
    }
  ])(
    'retires a persistence-only dead owner before fresh recovery ($label)',
    async ({ worktreeId, cwd, folderMissing }) => {
      const tabId = 'tab-dead-persisted-owner'
      const leafId = '12121212-1212-4212-8212-121212121212'
      const paneKey = makePaneKey(tabId, leafId)
      const providerSpawn = vi.fn(
        async (options: { attachOnly?: boolean; command?: string; sessionId?: string }) => {
          if (options.attachOnly) {
            throw new Error('Session not found: pty-dead-persisted-owner')
          }
          return { id: 'pty-fresh-recovery', incarnationId: 'inc-fresh-recovery' }
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
        attach: vi.fn(),
        getDefaultShell: vi.fn(),
        getProfiles: vi.fn()
      } as never)
      let session = {
        tabsByWorktree: {
          [worktreeId]: [{ id: tabId, worktreeId, ptyId: 'pty-dead-persisted-owner' }]
        },
        terminalLayoutsByTabId: {
          [tabId]: {
            root: { type: 'leaf' as const, leafId },
            activeLeafId: leafId,
            expandedLeafId: null,
            ptyIdsByLeafId: { [leafId]: 'pty-dead-persisted-owner' }
          }
        },
        terminalPtyIncarnationsByPaneKey: { [paneKey]: 'inc-dead-persisted-owner' }
      }
      const store = {
        getWorkspaceSession: vi.fn(() => session),
        setWorkspaceSession: vi.fn((next) => {
          session = next
        }),
        flushOrThrow: vi.fn(),
        persistPtyBinding: vi.fn(),
        getFolderWorkspace: vi.fn(() => ({
          id: 'dead-persisted-owner',
          folderPath: cwd,
          projectGroupId: 'folder-group'
        })),
        getFolderWorkspaces: vi.fn(() => [
          {
            id: 'dead-persisted-owner',
            folderPath: cwd,
            projectGroupId: 'folder-group'
          }
        ]),
        getProjectGroups: vi.fn(() => []),
        getRepos: vi.fn(() => [])
      }
      const runtime = {
        setPtyController: vi.fn(),
        resolveTerminalPane: vi.fn(() => {
          throw new Error('terminal_not_found')
        }),
        createPreAllocatedTerminalHandle: vi.fn(() => 'term-fresh-recovery'),
        preAllocateHandleForPty: vi.fn(() => 'term-fresh-recovery'),
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
        undefined,
        store as never
      )
      if (folderMissing) {
        statSyncMock.mockImplementation(() => {
          throw Object.assign(new Error('missing folder'), { code: 'ENOENT' })
        })
      }
      const mountedPromise = handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd,
        command: 'codex resume exact-dead-provider-session',
        worktreeId,
        tabId,
        leafId,
        env: {
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: tabId,
          ORCA_WORKTREE_ID: worktreeId
        }
      })

      if (folderMissing) {
        await expect(mountedPromise).rejects.toThrow(`folder_workspace_path_missing:${cwd}`)
        expect(providerSpawn).toHaveBeenCalledOnce()
        expect(providerSpawn.mock.calls[0]?.[0]).toMatchObject({
          attachOnly: true,
          sessionId: 'pty-dead-persisted-owner',
          command: undefined
        })
        expect(store.setWorkspaceSession).toHaveBeenCalledOnce()
        expect(runtime.onPtyExit).toHaveBeenCalledWith(
          'pty-dead-persisted-owner',
          0,
          'inc-dead-persisted-owner'
        )
        return
      }
      const mounted = await mountedPromise

      expect(mounted).toMatchObject({
        id: 'pty-fresh-recovery',
        incarnationId: 'inc-fresh-recovery'
      })
      expect(providerSpawn).toHaveBeenCalledTimes(2)
      expect(providerSpawn.mock.calls[0]?.[0]).toMatchObject({
        attachOnly: true,
        sessionId: 'pty-dead-persisted-owner',
        command: undefined
      })
      expect(providerSpawn.mock.calls[1]?.[0]).toMatchObject({
        command: 'codex resume exact-dead-provider-session'
      })
      expect(store.setWorkspaceSession).toHaveBeenCalledOnce()
      expect(store.flushOrThrow).toHaveBeenCalledOnce()
      expect(runtime.onPtyExit).toHaveBeenCalledWith(
        'pty-dead-persisted-owner',
        0,
        'inc-dead-persisted-owner'
      )
    }
  )
  it('keeps a persisted owner when daemon routing is unresolved', async () => {
    const worktreeId = 'repo-1::/tmp/unproven-owner'
    const cwd = '/tmp/unproven-owner'
    const tabId = 'tab-unproven-owner'
    const leafId = '56565656-5656-4656-8656-565656565656'
    const paneKey = makePaneKey(tabId, leafId)
    const providerSpawn = vi.fn(
      async (options: { attachOnly?: boolean; command?: string; sessionId?: string }) => {
        if (options.attachOnly) {
          throw new TerminalSessionOwnerUnverifiedError('pty-unproven-owner')
        }
        return { id: 'pty-fresh-unproven', incarnationId: 'inc-fresh-unproven' }
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
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)
    let session = {
      tabsByWorktree: {
        [worktreeId]: [{ id: tabId, worktreeId, ptyId: 'pty-unproven-owner' }]
      },
      terminalLayoutsByTabId: {
        [tabId]: {
          root: { type: 'leaf' as const, leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: 'pty-unproven-owner' }
        }
      },
      terminalPtyIncarnationsByPaneKey: { [paneKey]: 'inc-unproven-owner' }
    }
    const store = {
      getWorkspaceSession: vi.fn(() => session),
      setWorkspaceSession: vi.fn((next) => {
        session = next
      }),
      flushOrThrow: vi.fn(),
      persistPtyBinding: vi.fn(),
      getFolderWorkspace: vi.fn(() => undefined),
      getFolderWorkspaces: vi.fn(() => []),
      getProjectGroups: vi.fn(() => []),
      getRepos: vi.fn(() => [])
    }
    const runtime = {
      setPtyController: vi.fn(),
      resolveTerminalPane: vi.fn(() => {
        throw new Error('terminal_not_found')
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term-unproven'),
      preAllocateHandleForPty: vi.fn(() => 'term-unproven'),
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
      undefined,
      store as never
    )

    await expect(
      handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd,
        command: 'codex resume unproven-owner-session',
        worktreeId,
        tabId,
        leafId,
        env: {
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: tabId,
          ORCA_WORKTREE_ID: worktreeId
        }
      })
    ).rejects.toThrow('terminal_pane_owner_unverified')

    // The live PTY keeps its pane binding, gets no synthetic exit, and is not duplicated.
    expect(providerSpawn).toHaveBeenCalledOnce()
    expect(providerSpawn.mock.calls[0]?.[0]).toMatchObject({ attachOnly: true })
    expect(runtime.onPtyExit).not.toHaveBeenCalled()
    expect(store.setWorkspaceSession).not.toHaveBeenCalled()
    expect(store.flushOrThrow).not.toHaveBeenCalled()
    expect(session.tabsByWorktree[worktreeId]).toHaveLength(1)
  })
})
