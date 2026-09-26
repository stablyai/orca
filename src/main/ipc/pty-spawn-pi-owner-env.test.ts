import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { createDaemonActiveProviderFixtures } from './pty-ipc-daemon-provider-fixtures'
import { registerPtyHandlers } from './pty'

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

const ownerEnv = {
  ORCA_PI_STATUS_OWNED: '1234',
  ORCA_PRIME_AGENT_STATUS_OWNED: '1234',
  ORCA_PI_TITLE_MARKER_OWNED: '1234'
}

describe('Pi ownership deletion requests for persistent daemons', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()
  const { setupDaemonAdapter, daemonSpawnAndGetOptions } = createDaemonActiveProviderFixtures({
    handlers,
    mainWindow
  })

  it.each(['host', 'request'] as const)(
    'deletes %s markers through the IPC spawn route',
    async (source) => {
      const options = await daemonSpawnAndGetOptions(
        source === 'request' ? ownerEnv : undefined,
        undefined,
        undefined,
        source === 'host' ? ownerEnv : undefined
      )
      expect(options.envToDelete).toEqual(expect.arrayContaining(Object.keys(ownerEnv)))
      for (const key of Object.keys(ownerEnv)) {
        expect(options.env[key]).toBeUndefined()
      }
    }
  )

  it('also sends deletion requests through the headless runtime spawn route', async () => {
    const daemonSpawn = setupDaemonAdapter()
    const runtime = {
      setPtyController: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }
    handlers.clear()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These fixtures implement the window/runtime methods exercised by PTY registration and spawn.
    registerPtyHandlers(mainWindow as never, runtime as never)
    const controller = runtime.setPtyController.mock.calls[0]?.[0]
    await controller.spawn({ cols: 80, rows: 24, env: { ...ownerEnv } })

    const options = daemonSpawn.mock.calls.at(-1)?.[0]
    expect(options).toEqual(
      expect.objectContaining({
        envToDelete: expect.arrayContaining(Object.keys(ownerEnv))
      })
    )
    for (const key of Object.keys(ownerEnv)) {
      expect(options?.env[key]).toBeUndefined()
    }
  })
})
