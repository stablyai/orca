import { describe, expect, it, vi } from 'vitest'
import { spawnMock, openCodeClearPtyMock, piClearPtyMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { makePaneKey } from '../../shared/stable-pane-id'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  SSH_PTY_IDENTITY_MISMATCH_ERROR,
  SSH_SESSION_EXPIRED_ERROR
} from '../providers/ssh-pty-errors'
import {
  registerPtyHandlers,
  registerSshPtyProvider,
  clearProviderPtyState,
  deletePtyOwnership,
  hasPendingRendererSerializerForPaneKey,
  setPtyOwnership,
  setLocalPtyProvider,
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
  const { handlers, mainWindow, mainWindowIpcEvent, getPtyWriteListener } = setupPtyIpcSuite()

  it('does not clear runtime-owned SSH reattach state on identity mismatch', async () => {
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
    const connectionId = 'ssh-identity-runtime'
    const appPtyId = `ssh:${connectionId}@@relay-pty`
    const remoteWrite = vi.fn()
    registerSshPtyProvider(connectionId, {
      spawn: vi.fn(async () => {
        throw new Error(
          `${SSH_SESSION_EXPIRED_ERROR}: relay-pty ${SSH_PTY_IDENTITY_MISMATCH_ERROR}`
        )
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
      getDriver: vi.fn(() => ({ kind: 'host' })),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }

    try {
      setPtyOwnership(appPtyId, connectionId)
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
          connectionId,
          worktreeId: 'wt-remote',
          tabId: 'tab-remote',
          leafId,
          sessionId: appPtyId,
          persistHostSessionBinding: true
        })
      ).rejects.toThrow(SSH_SESSION_EXPIRED_ERROR)

      expect(store.markSshRemotePtyLease).not.toHaveBeenCalledWith(
        connectionId,
        'relay-pty',
        'expired'
      )
      expect(store.upsertSshRemotePtyLease).not.toHaveBeenCalled()
      expect(store.persistPtyBinding).not.toHaveBeenCalled()
      expect(openCodeClearPtyMock).not.toHaveBeenCalledWith(appPtyId)
      expect(piClearPtyMock).not.toHaveBeenCalledWith(appPtyId)
      getPtyWriteListener()(mainWindowIpcEvent, { id: appPtyId, data: 'echo still-owned' })
      expect(remoteWrite).toHaveBeenCalledWith(appPtyId, 'echo still-owned')
    } finally {
      deletePtyOwnership(appPtyId)
      unregisterSshPtyProvider(connectionId)
    }
  })
  it('cleans up fresh runtime-owned SSH spawns when binding persistence fails', async () => {
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
    const appPtyId = 'ssh:ssh-fresh-fail@@relay-pty'
    const incarnationId = 'incarnation-fresh-fail'
    const runtime = new OrcaRuntimeService()
    const remoteShutdown = vi.fn(async () => {
      // Model the relay's exit callback winning before shutdown resolves.
      runtime.onPtyExit(appPtyId, 0, incarnationId)
    })
    registerSshPtyProvider('ssh-fresh-fail', {
      spawn: vi.fn(async () => ({ id: appPtyId, incarnationId })),
      write: vi.fn(),
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

    try {
      registerPtyHandlers(
        mainWindow as never,
        runtime as never,
        undefined,
        undefined,
        undefined,
        store as never
      )
      const spawnController = (runtime as unknown as { ptyController: RuntimeSpawnController })
        .ptyController
      const leafId = '11111111-1111-4111-8111-111111111111'

      await expect(
        spawnController.spawn({
          cols: 80,
          rows: 24,
          connectionId: 'ssh-fresh-fail',
          worktreeId: 'wt-remote',
          tabId: 'tab-remote',
          leafId,
          sessionId: appPtyId,
          persistHostSessionBinding: true
        })
      ).rejects.toThrow(/ORCA_TERMINAL_SESSION_STATE_SAVE_FAILED/)

      expect(remoteShutdown).toHaveBeenCalledWith(appPtyId, { immediate: true })
      expect(store.upsertSshRemotePtyLease).not.toHaveBeenCalled()
      expect(store.removeSshRemotePtyLease).not.toHaveBeenCalled()
      expect(openCodeClearPtyMock).toHaveBeenCalledWith(appPtyId)
      expect(piClearPtyMock).toHaveBeenCalledWith(appPtyId)
      const internals = runtime as unknown as {
        earlyExitedPtyIncarnations: Map<string, string | null>
        pendingPtyRegistrationIncarnations: Map<string, string | null>
      }
      expect(internals.earlyExitedPtyIncarnations.size).toBe(0)
      expect(internals.pendingPtyRegistrationIncarnations.size).toBe(0)
    } finally {
      unregisterSshPtyProvider('ssh-fresh-fail')
    }
  })
  it('maps runtime-owned spawn paneKeys for renderer serializer settlement', async () => {
    type RuntimeSpawnController = {
      spawn(args: {
        cols: number
        rows: number
        worktreeId?: string
        env?: Record<string, string>
      }): Promise<{ id: string }>
      hasRendererSerializer?(ptyId: string): boolean
      getRendererSerializerGeneration?(ptyId: string): number
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

    registerPtyHandlers(mainWindow as never, runtime as never)
    const paneKey = makePaneKey('tab-cli', '11111111-1111-4111-8111-111111111111')
    const gen = (await handlers.get('pty:declarePendingPaneSerializer')!(null, {
      paneKey
    })) as number
    const spawnController = controller as unknown as RuntimeSpawnController
    const result = await spawnController.spawn({
      cols: 80,
      rows: 24,
      worktreeId: 'wt-1',
      env: { ORCA_PANE_KEY: ` ${paneKey} ` }
    })
    const replacementGen = (await handlers.get('pty:declarePendingPaneSerializer')!(null, {
      paneKey
    })) as number

    expect(spawnController.hasRendererSerializer?.(result.id)).toBe(false)
    await handlers.get('pty:settlePaneSerializer')!(null, { paneKey, gen })
    expect(spawnController.hasRendererSerializer?.(result.id)).toBe(false)
    expect(spawnController.getRendererSerializerGeneration?.(result.id)).toBe(0)
    await handlers.get('pty:settlePaneSerializer')!(null, { paneKey, gen: replacementGen })
    expect(spawnController.hasRendererSerializer?.(result.id)).toBe(true)
    expect(spawnController.getRendererSerializerGeneration?.(result.id)).toBe(1)
  })
  it('does not let old teardown cancel serializer settlement for a reused PTY id', async () => {
    type RuntimeSpawnController = {
      spawn(args: {
        cols: number
        rows: number
        worktreeId?: string
        env?: Record<string, string>
      }): Promise<{ id: string }>
      getRendererSerializerGeneration?(ptyId: string): number
      hasRendererSerializer?(ptyId: string): boolean
      waitForRendererSerializer?(
        ptyId: string,
        afterGeneration: number,
        timeoutMs?: number
      ): Promise<boolean>
    }
    const reusedPtyId = 'pty-reused'
    setLocalPtyProvider({
      spawn: vi.fn(async () => ({ id: reusedPtyId })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => []),
      getForegroundProcess: vi.fn(async () => null)
    } as never)
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      }),
      preAllocateHandleForPty: vi.fn(() => null),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }
    registerPtyHandlers(mainWindow as never, runtime as never)
    const paneKey = makePaneKey('tab-reused', '33333333-3333-4333-8333-333333333333')
    const spawnController = controller as unknown as RuntimeSpawnController
    const spawn = async (): Promise<void> => {
      await spawnController.spawn({
        cols: 80,
        rows: 24,
        worktreeId: 'wt-1',
        env: { ORCA_PANE_KEY: paneKey }
      })
    }

    const firstGen = (await handlers.get('pty:declarePendingPaneSerializer')!(null, {
      paneKey
    })) as number
    await spawn()
    await handlers.get('pty:settlePaneSerializer')!(null, { paneKey, gen: firstGen })
    const priorGeneration = spawnController.getRendererSerializerGeneration?.(reusedPtyId) ?? 0

    const secondGen = (await handlers.get('pty:declarePendingPaneSerializer')!(null, {
      paneKey
    })) as number
    await spawn()
    const ready = spawnController.waitForRendererSerializer?.(reusedPtyId, priorGeneration, 1_000)
    clearProviderPtyState(reusedPtyId)
    clearProviderPtyState(reusedPtyId)
    await handlers.get('pty:settlePaneSerializer')!(null, { paneKey, gen: secondGen })

    await expect(ready).resolves.toBe(true)
    expect(spawnController.hasRendererSerializer?.(reusedPtyId)).toBe(true)
  })
  it('tracks exact remote-runtime serializer readiness without a local spawn mapping', async () => {
    type RuntimeSpawnController = {
      hasRendererSerializer?(ptyId: string): boolean
      getRendererSerializerGeneration?(ptyId: string): number
    }
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      })
    }

    registerPtyHandlers(mainWindow as never, runtime as never)
    const ptyId = 'remote:env-1@@terminal-1'
    const spawnController = controller as unknown as RuntimeSpawnController

    expect(spawnController.hasRendererSerializer?.(ptyId)).toBe(false)
    await handlers.get('pty:reportRendererSerializerReady')!(null, { ptyId: 'local-pty' })
    expect(spawnController.hasRendererSerializer?.('local-pty')).toBe(false)
    await handlers.get('pty:reportRendererSerializerReady')!(null, { ptyId })
    expect(spawnController.hasRendererSerializer?.(ptyId)).toBe(true)
    expect(spawnController.getRendererSerializerGeneration?.(ptyId)).toBe(1)
  })
  it('clears pending pane serializer declarations when their renderer is destroyed', async () => {
    registerPtyHandlers(mainWindow as never)
    const paneKey = makePaneKey('tab-crash', '22222222-2222-4222-8222-222222222222')
    const destroyedListeners: (() => void)[] = []
    const sender = {
      id: 42,
      isDestroyed: () => false,
      once: vi.fn((event: string, listener: () => void) => {
        if (event === 'destroyed') {
          destroyedListeners.push(listener)
        }
      })
    }

    await handlers.get('pty:declarePendingPaneSerializer')!({ sender }, { paneKey })

    expect(hasPendingRendererSerializerForPaneKey(paneKey)).toBe(true)
    expect(destroyedListeners).toHaveLength(1)
    destroyedListeners[0]()
    expect(hasPendingRendererSerializerForPaneKey(paneKey)).toBe(false)
  })
  it('does not retain a serializer declaration from an already-destroyed renderer', async () => {
    registerPtyHandlers(mainWindow as never)
    const paneKey = makePaneKey('tab-dead', '77777777-7777-4777-8777-777777777777')
    const sender = {
      id: 43,
      isDestroyed: () => true,
      once: vi.fn()
    }

    await handlers.get('pty:declarePendingPaneSerializer')!({ sender }, { paneKey })

    expect(hasPendingRendererSerializerForPaneKey(paneKey)).toBe(false)
    expect(sender.once).not.toHaveBeenCalled()
  })
  it('ignores renderer-provided ORCA_TERMINAL_HANDLE for local PTY spawns', async () => {
    const runtime = {
      setPtyController: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      preAllocateHandleForPty: vi.fn(() => 'term_trusted'),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }

    registerPtyHandlers(mainWindow as never, runtime as never)
    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      env: { ORCA_TERMINAL_HANDLE: 'term_untrusted' }
    })

    const spawnCall = spawnMock.mock.calls.at(-1)!
    const env = spawnCall[2].env as Record<string, string>
    expect(env.ORCA_TERMINAL_HANDLE).toBe('term_trusted')
    expect(runtime.preAllocateHandleForPty).toHaveBeenCalledWith(expect.any(String))
  })
  it('forwards the trusted Orca terminal handle into managed WSL terminals', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    const runtime = {
      setPtyController: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      preAllocateHandleForPty: vi.fn(() => 'term_wsl'),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }

    try {
      registerPtyHandlers(mainWindow as never, runtime as never)
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        shellOverride: 'wsl.exe'
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    const spawnCall = spawnMock.mock.calls.at(-1)!
    const env = spawnCall[2].env as Record<string, string>
    expect(spawnCall[0]).toBe('wsl.exe')
    expect(env.ORCA_TERMINAL_HANDLE).toBe('term_wsl')
    expect(env.ORCA_USER_DATA_PATH).toBe('/tmp/orca-user-data')
    expect(env.ORCA_CLI_COMMAND).toBe('orca-ide')
    expect(env.WSLENV?.split(':')).toEqual(
      expect.arrayContaining([
        'ORCA_TERMINAL_HANDLE/u',
        'ORCA_USER_DATA_PATH/p',
        'ORCA_CLI_COMMAND/u',
        'ORCA_AGENT_HOOK_PORT/u',
        'ORCA_AGENT_HOOK_TOKEN/u',
        // Why: bare WSL shells no longer create ~/.omp; only status extension is exported (#10196).
        'ORCA_OMP_STATUS_EXTENSION/p',
        'POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD'
      ])
    )
    expect(env.WSLENV?.split(':')).not.toEqual(
      expect.arrayContaining(['ORCA_OMP_SOURCE_AGENT_DIR/p'])
    )
  })
  it('forces managed ORCA_USER_DATA_PATH for WSL spawns even when the caller provides a stale root', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    const runtime = {
      setPtyController: vi.fn(),
      preAllocateHandleForPty: vi.fn(() => 'term_wsl'),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }

    try {
      registerPtyHandlers(mainWindow as never, runtime as never)
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        shellOverride: 'wsl.exe',
        env: {
          ORCA_USER_DATA_PATH: '/tmp/stale-orca-user-data'
        }
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    const spawnCall = spawnMock.mock.calls.at(-1)!
    const env = spawnCall[2].env as Record<string, string>
    expect(spawnCall[0]).toBe('wsl.exe')
    expect(env.ORCA_USER_DATA_PATH).toBe('/tmp/orca-user-data')
  })
})
