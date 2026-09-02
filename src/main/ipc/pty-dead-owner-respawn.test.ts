import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { makePaneKey } from '../../shared/stable-pane-id'
import { registerPtyHandlers, setLocalPtyProvider } from './pty'

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

  it('still retires and respawns when the routed provider confirms absence', async () => {
    const worktreeId = 'repo-1::/tmp/proven-absent-owner'
    const cwd = '/tmp/proven-absent-owner'
    const tabId = 'tab-proven-absent-owner'
    const leafId = '78787878-7878-4878-8878-787878787878'
    const paneKey = makePaneKey(tabId, leafId)
    const providerSpawn = vi.fn(
      async (options: { attachOnly?: boolean; command?: string; sessionId?: string }) => {
        if (options.attachOnly) {
          throw new Error('Session not found: pty-proven-absent-owner')
        }
        return { id: 'pty-fresh-proven', incarnationId: 'inc-fresh-proven' }
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
        [worktreeId]: [{ id: tabId, worktreeId, ptyId: 'pty-proven-absent-owner' }]
      },
      terminalLayoutsByTabId: {
        [tabId]: {
          root: { type: 'leaf' as const, leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: 'pty-proven-absent-owner' }
        }
      },
      terminalPtyIncarnationsByPaneKey: { [paneKey]: 'inc-proven-absent-owner' }
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
      createPreAllocatedTerminalHandle: vi.fn(() => 'term-proven-absent'),
      preAllocateHandleForPty: vi.fn(() => 'term-proven-absent'),
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

    const mounted = await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd,
      command: 'codex resume proven-absent-session',
      worktreeId,
      tabId,
      leafId,
      env: {
        ORCA_PANE_KEY: paneKey,
        ORCA_TAB_ID: tabId,
        ORCA_WORKTREE_ID: worktreeId
      }
    })

    expect(mounted).toMatchObject({ id: 'pty-fresh-proven' })
    expect(providerSpawn).toHaveBeenCalledTimes(2)
    expect(providerSpawn.mock.calls[1]?.[0]).toMatchObject({
      command: 'codex resume proven-absent-session'
    })
    expect(runtime.onPtyExit).toHaveBeenCalledWith(
      'pty-proven-absent-owner',
      0,
      'inc-proven-absent-owner'
    )
    expect(store.setWorkspaceSession).toHaveBeenCalledOnce()
    expect(store.flushOrThrow).toHaveBeenCalledOnce()
  })
  it('does not poll after the routed provider confirms absence', async () => {
    const worktreeId = 'repo-1::/tmp/probe-blip-owner'
    const cwd = '/tmp/probe-blip-owner'
    const tabId = 'tab-probe-blip-owner'
    const leafId = '67676767-6767-4767-8767-676767676767'
    const paneKey = makePaneKey(tabId, leafId)
    const providerSpawn = vi.fn(
      async (options: { attachOnly?: boolean; command?: string; sessionId?: string }) => {
        if (options.attachOnly) {
          throw new Error('Session not found: pty-probe-blip-owner')
        }
        return { id: 'pty-fresh-probe-blip', incarnationId: 'inc-fresh-probe-blip' }
      }
    )
    const probePtyLiveness = vi.fn(async () => null)
    setLocalPtyProvider({
      spawn: providerSpawn,
      probePtyLiveness,
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
        [worktreeId]: [{ id: tabId, worktreeId, ptyId: 'pty-probe-blip-owner' }]
      },
      terminalLayoutsByTabId: {
        [tabId]: {
          root: { type: 'leaf' as const, leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: 'pty-probe-blip-owner' }
        }
      },
      terminalPtyIncarnationsByPaneKey: { [paneKey]: 'inc-probe-blip-owner' }
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
      createPreAllocatedTerminalHandle: vi.fn(() => 'term-probe-blip'),
      preAllocateHandleForPty: vi.fn(() => 'term-probe-blip'),
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

    const mounted = await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd,
      command: 'codex resume probe-blip-session',
      worktreeId,
      tabId,
      leafId,
      env: {
        ORCA_PANE_KEY: paneKey,
        ORCA_TAB_ID: tabId,
        ORCA_WORKTREE_ID: worktreeId
      }
    })

    expect(probePtyLiveness).not.toHaveBeenCalled()
    expect(mounted).toMatchObject({ id: 'pty-fresh-probe-blip' })
    expect(providerSpawn).toHaveBeenCalledTimes(2)
    expect(runtime.onPtyExit).toHaveBeenCalledWith(
      'pty-probe-blip-owner',
      0,
      'inc-probe-blip-owner'
    )
  })
  // Why: a parked pane (stopped with keepHistory) leaves the runtime holding the binding while
  // persistence has already dropped it. Reading "nothing left to retire" as a competing owner
  // aborted materialization *after* signalling the exit, which destroyed the pane instead of
  // rebuilding it — the reconnect path then had no surface to attach to (#11541).
  it('respawns a proven-dead owner whose persisted binding was already retired', async () => {
    const worktreeId = 'repo-1::/tmp/already-retired-owner'
    const cwd = '/tmp/already-retired-owner'
    const tabId = 'tab-already-retired-owner'
    const leafId = '89898989-8989-4989-8989-898989898989'
    const paneKey = makePaneKey(tabId, leafId)
    const providerSpawn = vi.fn(
      async (options: { attachOnly?: boolean; command?: string; sessionId?: string }) => {
        if (options.attachOnly) {
          throw new Error('Session not found: pty-already-retired-owner')
        }
        return { id: 'pty-fresh-already-retired', incarnationId: 'inc-fresh-already-retired' }
      }
    )
    const probePtyLiveness = vi.fn(async () => false)
    setLocalPtyProvider({
      spawn: providerSpawn,
      probePtyLiveness,
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
    // Persistence kept the tab but already dropped this leaf's PTY binding, exactly as an
    // earlier keep-history stop leaves it.
    let session = {
      tabsByWorktree: {
        [worktreeId]: [{ id: tabId, worktreeId, ptyId: null }]
      },
      terminalLayoutsByTabId: {
        [tabId]: {
          root: { type: 'leaf' as const, leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      },
      terminalPtyIncarnationsByPaneKey: {}
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
    let runtimeOwnsPane = true
    const runtime = {
      setPtyController: vi.fn(),
      resolveTerminalPane: vi.fn(() => {
        if (!runtimeOwnsPane) {
          throw new Error('terminal_not_found')
        }
        return {
          ptyId: 'pty-already-retired-owner',
          tabId,
          leafId,
          handle: 'term-already-retired',
          connected: true
        }
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term-already-retired-fresh'),
      preAllocateHandleForPty: vi.fn(() => 'term-already-retired-fresh'),
      registerPreAllocatedHandleForPty: vi.fn(),
      beginPtyRegistration: vi.fn(),
      cancelPendingPtyRegistration: vi.fn(),
      assertPtyRegistrationAllowed: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      seedHeadlessTerminal: vi.fn(),
      onPtySpawned: vi.fn(),
      // Why: the real runtime drops its pane binding on exit; the guard after retirement must
      // see that release rather than a resurrected owner.
      onPtyExit: vi.fn(() => {
        runtimeOwnsPane = false
      }),
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

    const mounted = await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd,
      command: 'codex resume already-retired-session',
      worktreeId,
      tabId,
      leafId,
      env: {
        ORCA_PANE_KEY: paneKey,
        ORCA_TAB_ID: tabId,
        ORCA_WORKTREE_ID: worktreeId
      }
    })

    expect(probePtyLiveness).not.toHaveBeenCalled()
    expect(mounted).toMatchObject({ id: 'pty-fresh-already-retired' })
    expect(providerSpawn).toHaveBeenCalledTimes(2)
    expect(providerSpawn.mock.calls[1]?.[0]).toMatchObject({
      command: 'codex resume already-retired-session'
    })
    expect(runtime.onPtyExit).toHaveBeenCalledWith('pty-already-retired-owner', 0, undefined)
  })
})
