import { describe, expect, it, vi } from 'vitest'
import { spawnMock, openCodeClearPtyMock, piClearPtyMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { makePaneKey } from '../../shared/stable-pane-id'
import { SSH_SESSION_EXPIRED_ERROR } from '../providers/ssh-pty-errors'
import {
  registerPtyHandlers,
  registerSshPtyProvider,
  deletePtyOwnership,
  setPtyOwnership,
  unregisterSshPtyProvider
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
  const { mainWindow, mainWindowIpcEvent, getPtyWriteListener } = setupPtyIpcSuite()

  it('rejects runtime-owned binding persistence without complete stable identity', async () => {
    type RuntimeSpawnController = {
      spawn(args: {
        cols: number
        rows: number
        worktreeId?: string
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
    const validLeafId = '11111111-1111-4111-8111-111111111111'
    const baseArgs = {
      cols: 80,
      rows: 24,
      worktreeId: 'wt-1',
      tabId: 'tab-headless',
      leafId: validLeafId,
      persistHostSessionBinding: true
    }

    for (const args of [
      { ...baseArgs, worktreeId: undefined },
      { ...baseArgs, tabId: undefined },
      { ...baseArgs, leafId: undefined },
      { ...baseArgs, leafId: 'legacy-leaf' }
    ]) {
      await expect(spawnController.spawn(args)).rejects.toThrow(
        'Cannot persist runtime PTY binding without worktreeId, tabId, and leafId'
      )
    }
    expect(spawnMock).not.toHaveBeenCalled()
    expect(store.persistPtyBinding).not.toHaveBeenCalled()
  })
  it('refreshes SSH leases after successful runtime-owned reattach binding', async () => {
    type RuntimeSpawnController = {
      spawn(args: {
        cols: number
        rows: number
        worktreeId?: string
        connectionId?: string
        tabId?: string
        leafId?: string
        sessionId?: string
        persistHostSessionBinding?: boolean
      }): Promise<{ id: string; isReattach?: boolean }>
    }
    registerSshPtyProvider('ssh-reattach-ok', {
      spawn: vi.fn(async () => ({ id: 'ssh:ssh-reattach-ok@@relay-pty', isReattach: true })),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)
    const store = {
      upsertSshRemotePtyLease: vi.fn(),
      persistPtyBinding: vi.fn(),
      removeSshRemotePtyLease: vi.fn(),
      markSshRemotePtyLease: vi.fn()
    }
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_remote'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }

    try {
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
        connectionId: 'ssh-reattach-ok',
        worktreeId: 'wt-remote',
        tabId: 'tab-remote',
        leafId,
        sessionId: 'ssh:ssh-reattach-ok@@relay-pty',
        persistHostSessionBinding: true
      })

      expect(store.persistPtyBinding).toHaveBeenCalledWith(
        {
          worktreeId: 'wt-remote',
          tabId: 'tab-remote',
          leafId,
          ptyId: 'ssh:ssh-reattach-ok@@relay-pty',
          hostAdmittedMembership: true
        },
        'ssh:ssh-reattach-ok'
      )
      expect(store.upsertSshRemotePtyLease).toHaveBeenCalledWith(
        expect.objectContaining({
          targetId: 'ssh-reattach-ok',
          ptyId: 'relay-pty',
          state: 'attached',
          lastAttachedAt: expect.any(Number)
        })
      )
    } finally {
      unregisterSshPtyProvider('ssh-reattach-ok')
    }
  })
  it('strips runtime-owned SSH pane env when remote agent hooks are disabled', async () => {
    type RuntimeSpawnController = {
      spawn(args: {
        cols: number
        rows: number
        env?: Record<string, string>
        worktreeId?: string
        connectionId?: string
        tabId?: string
        leafId?: string
        persistHostSessionBinding?: boolean
      }): Promise<{ id: string }>
    }
    const savedRemoteHooks = process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS
    process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS = '0'
    const remoteSpawn = vi.fn(
      async (_opts: { env?: Record<string, string>; envToDelete?: string[] }) => ({
        id: 'ssh:ssh-runtime-env@@relay-pty'
      })
    )
    registerSshPtyProvider('ssh-runtime-env', {
      spawn: remoteSpawn,
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)
    const store = {
      upsertSshRemotePtyLease: vi.fn(),
      persistPtyBinding: vi.fn()
    }
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_remote'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      getDriver: vi.fn(() => ({ kind: 'host' })),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }

    try {
      registerPtyHandlers(
        mainWindow as never,
        runtime as never,
        undefined,
        (() => ({
          agentStatusHooksEnabled: false,
          codexSystemDefaultRealHomeEnabled: true
        })) as never,
        undefined,
        store as never
      )
      const spawnController = controller as unknown as RuntimeSpawnController
      const leafId = '11111111-1111-4111-8111-111111111111'
      await spawnController.spawn({
        cols: 80,
        rows: 24,
        env: {
          FOO: 'bar',
          ORCA_PANE_KEY: makePaneKey('tab-remote', leafId),
          ORCA_TAB_ID: 'tab-remote',
          ORCA_WORKTREE_ID: 'wt-remote'
        },
        connectionId: 'ssh-runtime-env',
        worktreeId: 'wt-remote',
        tabId: 'tab-remote',
        leafId,
        persistHostSessionBinding: true
      })

      const spawnOptions = remoteSpawn.mock.calls[0]?.[0]
      const env = spawnOptions.env
      expect(env).toMatchObject({ FOO: 'bar' })
      expect(env?.ORCA_PANE_KEY).toBeUndefined()
      expect(env?.ORCA_TAB_ID).toBeUndefined()
      expect(env?.ORCA_WORKTREE_ID).toBeUndefined()
      expect(spawnOptions.envToDelete ?? []).not.toContain('CODEX_HOME')
      expect(spawnOptions.envToDelete ?? []).not.toContain('ORCA_CODEX_HOME')
      expect(store.upsertSshRemotePtyLease).toHaveBeenCalledWith(
        expect.objectContaining({
          targetId: 'ssh-runtime-env',
          ptyId: 'relay-pty',
          leafId,
          state: 'attached'
        })
      )
    } finally {
      if (savedRemoteHooks === undefined) {
        delete process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS
      } else {
        process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS = savedRemoteHooks
      }
      unregisterSshPtyProvider('ssh-runtime-env')
    }
  })
  it('preserves adopted SSH ownership when runtime binding persistence fails', async () => {
    type RuntimeSpawnController = {
      spawn(args: {
        cols: number
        rows: number
        worktreeId?: string
        connectionId?: string
        tabId?: string
        leafId?: string
        sessionId?: string
        persistHostSessionBinding?: boolean
      }): Promise<{ id: string }>
    }
    const remoteShutdown = vi.fn()
    const remoteWrite = vi.fn()
    registerSshPtyProvider('ssh-reattach-fail', {
      spawn: vi.fn(async () => ({ id: 'ssh:ssh-reattach-fail@@relay-pty', isReattach: true })),
      write: remoteWrite,
      resize: vi.fn(),
      shutdown: remoteShutdown,
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)
    const store = {
      upsertSshRemotePtyLease: vi.fn(),
      persistPtyBinding: vi.fn(() => {
        throw new Error('disk full')
      }),
      removeSshRemotePtyLease: vi.fn(),
      markSshRemotePtyLease: vi.fn()
    }
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_remote'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      getDriver: vi.fn(() => ({ kind: 'host' })),
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

    await expect(
      spawnController.spawn({
        cols: 80,
        rows: 24,
        connectionId: 'ssh-reattach-fail',
        worktreeId: 'wt-remote',
        tabId: 'tab-remote',
        leafId,
        sessionId: 'ssh:ssh-reattach-fail@@relay-pty',
        persistHostSessionBinding: true
      })
    ).rejects.toThrow(/ORCA_TERMINAL_SESSION_STATE_SAVE_FAILED/)

    expect(store.upsertSshRemotePtyLease).not.toHaveBeenCalled()
    expect(store.removeSshRemotePtyLease).not.toHaveBeenCalled()
    expect(remoteShutdown).not.toHaveBeenCalled()
    getPtyWriteListener()(mainWindowIpcEvent, {
      id: 'ssh:ssh-reattach-fail@@relay-pty',
      data: 'echo remains-routable'
    })
    expect(remoteWrite).toHaveBeenCalledWith(
      'ssh:ssh-reattach-fail@@relay-pty',
      'echo remains-routable'
    )
    unregisterSshPtyProvider('ssh-reattach-fail')
  })
  it('marks runtime-owned SSH reattach as expired and clears stale local ownership', async () => {
    type RuntimeSpawnController = {
      spawn(args: {
        cols: number
        rows: number
        worktreeId?: string
        connectionId?: string
        tabId?: string
        leafId?: string
        sessionId?: string
        persistHostSessionBinding?: boolean
      }): Promise<{ id: string }>
    }
    const appPtyId = 'ssh:ssh-expired-runtime@@relay-pty'
    const remoteWrite = vi.fn()
    registerSshPtyProvider('ssh-expired-runtime', {
      spawn: vi.fn(async () => {
        throw new Error(`${SSH_SESSION_EXPIRED_ERROR}: relay-pty`)
      }),
      write: remoteWrite,
      resize: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)
    const store = {
      upsertSshRemotePtyLease: vi.fn(),
      persistPtyBinding: vi.fn(),
      removeSshRemotePtyLease: vi.fn(),
      markSshRemotePtyLease: vi.fn()
    }
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_remote'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      getDriver: vi.fn(() => ({ kind: 'host' })),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }

    try {
      setPtyOwnership(appPtyId, 'ssh-expired-runtime')
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

      await expect(
        spawnController.spawn({
          cols: 80,
          rows: 24,
          connectionId: 'ssh-expired-runtime',
          worktreeId: 'wt-remote',
          tabId: 'tab-remote',
          leafId,
          sessionId: appPtyId,
          persistHostSessionBinding: true
        })
      ).rejects.toThrow(SSH_SESSION_EXPIRED_ERROR)

      expect(store.markSshRemotePtyLease).toHaveBeenCalledWith(
        'ssh-expired-runtime',
        'relay-pty',
        'expired'
      )
      expect(store.upsertSshRemotePtyLease).not.toHaveBeenCalled()
      expect(store.persistPtyBinding).not.toHaveBeenCalled()
      expect(openCodeClearPtyMock).toHaveBeenCalledWith(appPtyId)
      expect(piClearPtyMock).toHaveBeenCalledWith(appPtyId)
      getPtyWriteListener()(mainWindowIpcEvent, { id: appPtyId, data: 'echo nope' })
      expect(remoteWrite).not.toHaveBeenCalled()
    } finally {
      deletePtyOwnership(appPtyId)
      unregisterSshPtyProvider('ssh-expired-runtime')
    }
  })
})
