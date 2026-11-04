import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { statSyncMock, spawnMock, wslUncDirectoryExistsAsyncMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'

import { registerPtyHandlers } from './register-handlers'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('node:fs/promises', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).fsPromisesModuleMock(await importOriginal())
)
vi.mock('../../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)
const runningStateMock = vi.hoisted(() =>
  vi.fn(async (_distro: string, _options?: unknown) => 'stopped')
)
vi.mock('../../wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readWslDistroRunningState: runningStateMock
}))

const WSL_RUNTIME = {
  status: 'resolved',
  runtime: {
    kind: 'wsl',
    hostPlatform: 'wsl',
    projectId: 'repo-1',
    distro: 'Ubuntu',
    reason: 'project-override',
    cacheKey: 'repo-1:wsl'
  }
} as const

// E9: a restore the user did not ask for must not start a stopped distro, whatever provider runs.
describe('a passive WSL restore with a stopped distro', () => {
  const { handlers, mainWindow, installDaemonTestProvider } = setupPtyIpcSuite()
  const originalPlatform = process.platform

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    runningStateMock.mockReset().mockResolvedValue('stopped')
    wslUncDirectoryExistsAsyncMock.mockReset().mockResolvedValue(true)
    statSyncMock.mockImplementation(() => ({ isDirectory: () => true, mode: 0o755 }))
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  })

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the suite's window fake implements what the handlers read.
  const register = (): void => registerPtyHandlers(mainWindow as never)

  const restore = (overrides: Record<string, unknown> = {}) =>
    handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd: '/home/me/repo',
      worktreeId: 'repo-1::C:\\Users\\me\\repo',
      sessionId: 'repo-1::C:\\Users\\me\\repo@@restored',
      projectRuntime: WSL_RUNTIME,
      wslPassiveRestore: true,
      ...overrides
    })

  it('holds with the local provider (daemon off), before the cwd probe or any spawn', async () => {
    register()
    await expect(restore()).rejects.toThrow()
    expect(runningStateMock).toHaveBeenCalledWith('Ubuntu', expect.anything())
    expect(wslUncDirectoryExistsAsyncMock).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('holds with the daemon provider too, before its cwd probe', async () => {
    const providerSpawn = vi.fn().mockResolvedValue({ id: 'pty-daemon' })
    installDaemonTestProvider({ spawn: providerSpawn })
    register()
    await expect(restore()).rejects.toThrow()
    expect(wslUncDirectoryExistsAsyncMock).not.toHaveBeenCalled()
    expect(providerSpawn).not.toHaveBeenCalled()
  })

  it('restores once the distro runs, and never holds a restore the user asked for', async () => {
    register()
    runningStateMock.mockResolvedValue('running')
    await restore()
    expect(spawnMock).toHaveBeenCalledTimes(1)

    runningStateMock.mockResolvedValue('stopped')
    runningStateMock.mockClear()
    await restore({ wslPassiveRestore: undefined, sessionId: 'repo-1::C:\\Users\\me\\repo@@other' })
    expect(runningStateMock).not.toHaveBeenCalled()
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })
})
