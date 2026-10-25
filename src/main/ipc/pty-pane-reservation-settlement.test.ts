import { describe, expect, it, vi } from 'vitest'
import { spawnMock, registerPtyMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { makePaneKey } from '../../shared/stable-pane-id'
import { registerPtyHandlers } from './pty/register-handlers'
import { setLocalPtyProvider } from './pty/provider/registry'

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

  it('fails closed when runtime and persisted stable-pane owners conflict', async () => {
    const tabId = 'tab-conflicting-owner'
    const leafId = '99999999-9999-4999-8999-999999999999'
    const paneKey = makePaneKey(tabId, leafId)
    const worktreeId = 'repo-1::/tmp/conflicting-owner'
    const providerSpawn = vi.fn()
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
      resolveTerminalPane: vi.fn(() => ({
        handle: 'term-runtime-owner',
        tabId,
        leafId,
        ptyId: 'pty-runtime-owner',
        worktreeId
      })),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term-provisional')
    }
    const store = {
      getWorkspaceSession: vi.fn(() => ({
        tabsByWorktree: {
          [worktreeId]: [{ id: tabId, worktreeId, ptyId: 'pty-persisted-owner' }]
        },
        terminalLayoutsByTabId: {
          [tabId]: { ptyIdsByLeafId: { [leafId]: 'pty-persisted-owner' } }
        }
      }))
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
        cwd: '/tmp/conflicting-owner',
        worktreeId,
        tabId,
        leafId,
        env: {
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: tabId,
          ORCA_WORKTREE_ID: worktreeId
        }
      })
    ).rejects.toThrow('terminal_pane_owner_conflict')
    expect(providerSpawn).not.toHaveBeenCalled()
  })
  it('does not coalesce identical pane coordinates across worktrees', async () => {
    const providerSpawn = vi.fn(async () => ({ id: `pty-${providerSpawn.mock.calls.length}` }))
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
    registerPtyHandlers(mainWindow as never)
    const leafId = '77777777-7777-4777-8777-777777777777'
    const paneKey = makePaneKey('tab-host-scope', leafId)
    const spawn = (worktreeId: string) =>
      handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        worktreeId,
        tabId: 'tab-host-scope',
        leafId,
        env: {
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: 'tab-host-scope',
          ORCA_WORKTREE_ID: worktreeId
        }
      })

    await Promise.all([spawn('repo-1::/tmp/a'), spawn('repo-1::/tmp/b')])

    expect(providerSpawn).toHaveBeenCalledTimes(2)
  })
  it('settles the pane reservation when a post-spawn step throws so later spawns do not hang', async () => {
    // Post-spawn throws must release the reservation or later spawns for this pane hang.
    registerPtyHandlers(mainWindow as never)
    const leafId = '44444444-4444-4444-8444-444444444444'
    const spawnArgs = { cols: 80, rows: 24, tabId: 'tab-reservation', leafId }

    registerPtyMock.mockImplementationOnce(() => {
      throw new Error('boom: post-spawn registration failed')
    })

    await expect(handlers.get('pty:spawn')!(null, spawnArgs)).rejects.toThrow('boom')

    let hangTimer: ReturnType<typeof setTimeout> | undefined
    const second = handlers.get('pty:spawn')!(null, spawnArgs) as Promise<{ id: string }>
    const result = await Promise.race([
      second,
      new Promise<never>((_, reject) => {
        hangTimer = setTimeout(
          () => reject(new Error('second spawn hung: pane reservation leaked')),
          1000
        )
      })
    ]).finally(() => clearTimeout(hangTimer))

    expect(result.id).toEqual(expect.any(String))
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })
  it('settles the runtime-owned pane reservation when a post-spawn step throws so later spawns do not hang', async () => {
    // Runtime post-spawn throws need the same reservation cleanup as renderer spawns.
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
    let spawnCount = 0
    const providerSpawn = vi.fn(async () => ({ id: `pty-${++spawnCount}` }))
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
      registerPty: vi.fn().mockImplementationOnce(() => {
        throw new Error('boom: runtime registration failed')
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
    const spawnController = controller as unknown as RuntimeSpawnController
    const leafId = '55555555-5555-4555-8555-555555555555'
    const paneKey = makePaneKey('tab-runtime-reservation', leafId)
    const spawnArgs = {
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      worktreeId: 'wt-1',
      tabId: 'tab-runtime-reservation',
      leafId,
      env: { ORCA_PANE_KEY: paneKey },
      persistHostSessionBinding: true
    }

    await expect(spawnController.spawn(spawnArgs)).rejects.toThrow('boom')

    let hangTimer: ReturnType<typeof setTimeout> | undefined
    const second = spawnController.spawn(spawnArgs)
    const result = await Promise.race([
      second,
      new Promise<never>((_, reject) => {
        hangTimer = setTimeout(
          () => reject(new Error('second runtime spawn hung: pane reservation leaked')),
          1000
        )
      })
    ]).finally(() => clearTimeout(hangTimer))
    expect(result.id).toEqual(expect.any(String))
    expect(providerSpawn).toHaveBeenCalledTimes(2)
  })
})
