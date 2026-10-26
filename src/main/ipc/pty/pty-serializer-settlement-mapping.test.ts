import { describe, expect, it, vi } from 'vitest'
import { spawnMock } from '../pty-ipc-mock-registry'
import { setupPtyIpcSuite } from '../pty-ipc-test-harness'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type * as WslManagedCliModule from '../../cli/wsl-managed-cli'
import { registerPtyHandlers } from './register-handlers'
import { clearProviderPtyState } from './provider/state-cleanup'
import { hasPendingRendererSerializerForPaneKey } from './pane/serializer-state'
import { setLocalPtyProvider } from './provider/registry'

vi.mock('electron', () => import('../pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('../pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('../pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('../pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../../opencode/hook-service', () =>
  import('../pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../../mimo/hook-service', () =>
  import('../pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../../agent-hooks/server', () =>
  import('../pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../../pi/titlebar-extension-service', () =>
  import('../pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../../pwsh', () => import('../pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../../wsl', async (importOriginal) =>
  (await import('../pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../../telemetry/client', () =>
  import('../pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../../telemetry/classify-error', () =>
  import('../pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
const managedWslCliDir = vi.hoisted(() =>
  vi.fn((): string | null => 'C:\\orca-user-data\\wsl-managed-cli\\hash')
)
vi.mock('../../cli/wsl-managed-cli', async (importOriginal) => ({
  ...(await importOriginal<typeof WslManagedCliModule>()),
  getManagedWslCliDir: managedWslCliDir
}))
vi.mock('../../cli/linux-terminal-orca-cli-shim', () =>
  import('../pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../../memory/pty-registry', () =>
  import('../pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../../agent-hooks/migration-unsupported-pty-state', () =>
  import('../pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../../codex/codex-pane-account-registry', () =>
  import('../pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../../codex/codex-state-db-backfill-recovery', () =>
  import('../pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

describe('registerPtyHandlers', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()

  it('maps runtime-owned spawn paneKeys for renderer serializer settlement', async () => {
    type RuntimeSpawnController = {
      spawn(args: {
        cols: number
        rows: number
        worktreeId?: string
        tabId?: string
        leafId?: string
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
      tabId: 'tab-cli',
      leafId: '11111111-1111-4111-8111-111111111111',
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
        tabId?: string
        leafId?: string
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
        tabId: 'tab-reused',
        leafId: '33333333-3333-4333-8333-333333333333',
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
      env: { ORCA_TERMINAL_HANDLE: 'term_untrusted', ORCA_WSL_CLI_DIR: 'C:\\stale' }
    })

    const spawnCall = spawnMock.mock.calls.at(-1)!
    const env = spawnCall[2].env as Record<string, string>
    expect(env.ORCA_TERMINAL_HANDLE).toBe('term_trusted')
    expect(env.ORCA_WSL_CLI_DIR).toBeUndefined()
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
    expect(env.ORCA_WSL_CLI_DIR).toBe('C:\\orca-user-data\\wsl-managed-cli\\hash')
    expect(env.WSLENV?.split(':')).toEqual(
      expect.arrayContaining([
        'ORCA_TERMINAL_HANDLE/u',
        'ORCA_USER_DATA_PATH/p',
        'ORCA_CLI_COMMAND/u',
        'ORCA_WSL_CLI_DIR/p',
        'ORCA_AGENT_HOOK_PORT/u',
        'ORCA_AGENT_HOOK_TOKEN/u',
        // Bare WSL shells expose OMP status without creating ~/.omp (#10196).
        'ORCA_OMP_STATUS_EXTENSION/u',
        'POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD'
      ])
    )
    expect(env.WSLENV?.split(':')).not.toEqual(
      expect.arrayContaining(['ORCA_OMP_SOURCE_AGENT_DIR/p'])
    )
  })
  it('forces managed WSL env over stale caller values, even when CLI setup fails', async () => {
    managedWslCliDir.mockReturnValueOnce(null)
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
          ORCA_USER_DATA_PATH: '/tmp/stale-orca-user-data',
          ORCA_WSL_CLI_DIR: '/tmp/stale-wsl-cli'
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
    expect(env.ORCA_WSL_CLI_DIR).toBeUndefined()
  })
})
