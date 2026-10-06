import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { makePaneKey } from '../../shared/stable-pane-id'
import { registerPtyHandlers, registerSshPtyProvider, unregisterSshPtyProvider } from './pty'

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

describe('runtime PTY admission carries the launch starting view', () => {
  const { mainWindow } = setupPtyIpcSuite()

  it.each(['chat', 'terminal'] as const)(
    'hands an SSH fresh spawn its starting view (%s) for the first binding write',
    async (startingViewMode) => {
      type RuntimeSpawnController = {
        spawn(args: Record<string, unknown>): Promise<{ id: string }>
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a fresh runtime spawn reaches only spawn and the listener hooks.
      registerSshPtyProvider('ssh-start-view', {
        spawn: vi.fn(async () => ({ id: 'ssh:ssh-start-view@@relay-pty' })),
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
        supersedeSshRemotePtyLeasesForBoundPane: vi.fn(),
        persistPtyBinding: vi.fn(async () => true)
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
          undefined,
          undefined,
          store as never
        )
        const spawnController = controller as unknown as RuntimeSpawnController
        const leafId = '11111111-1111-4111-8111-111111111111'
        await spawnController.spawn({
          cols: 80,
          rows: 24,
          env: { ORCA_PANE_KEY: makePaneKey('tab-remote', leafId) },
          connectionId: 'ssh-start-view',
          worktreeId: 'wt-remote',
          tabId: 'tab-remote',
          leafId,
          persistHostSessionBinding: true,
          startingViewMode
        })

        expect(store.persistPtyBinding).toHaveBeenCalledWith(
          expect.objectContaining({
            worktreeId: 'wt-remote',
            tabId: 'tab-remote',
            leafId,
            hostAdmittedMembership: true,
            startingViewMode
          }),
          'ssh:ssh-start-view'
        )
      } finally {
        unregisterSshPtyProvider('ssh-start-view')
      }
    }
  )
})
