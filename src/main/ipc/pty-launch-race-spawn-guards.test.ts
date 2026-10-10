import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import {
  createLaunchRaceRuntime,
  installLaunchRaceProvider,
  launchRacePane,
  registerLaunchRaceLanes
} from './pty-launch-race-test-fixture'

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

function recordingWorktreeLock() {
  return vi.fn(async (_worktreeId?: string, _opts?: { refuseSleptWorktree?: boolean }) => () => {})
}

// Pins main's current launch behaviour as the convergence parity baseline (slept-worktree and
// client-disconnect guards, which only the runtime lane has).
describe('launch race parity: spawn guards, both spawn lanes', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()

  it('runtime lane asks the worktree spawn lock to refuse a slept worktree (runtime/spawn-execute.ts:25-30)', async () => {
    const pane = launchRacePane('guard-refuse-runtime', '91919191-9191-4191-8191-919191919191')
    installLaunchRaceProvider(async () => ({ id: 'pty-guard-refuse-runtime' }))
    const acquireWorktreeTerminalSpawn = recordingWorktreeLock()
    const runtime = createLaunchRaceRuntime({ acquireWorktreeTerminalSpawn })
    const lanes = registerLaunchRaceLanes({ handlers, mainWindow, runtime })

    await lanes.controller.spawn({ ...pane.args, refuseSleptWorktree: true })

    expect(acquireWorktreeTerminalSpawn).toHaveBeenCalledWith(pane.worktreeId, {
      refuseSleptWorktree: true
    })
  })

  // Lane drift: the IPC lane never forwards a slept-worktree refusal, so its spawns always wake.
  it('IPC lane takes the worktree spawn lock with no slept-worktree refusal (ipc/spawn-options.ts:238-241)', async () => {
    const pane = launchRacePane('guard-refuse-ipc', '92929292-9292-4292-8292-929292929292')
    installLaunchRaceProvider(async () => ({ id: 'pty-guard-refuse-ipc' }))
    const acquireWorktreeTerminalSpawn = recordingWorktreeLock()
    const runtime = createLaunchRaceRuntime({ acquireWorktreeTerminalSpawn })
    const lanes = registerLaunchRaceLanes({ handlers, mainWindow, runtime })

    await lanes.spawnThroughIpc({ ...pane.args, refuseSleptWorktree: true })

    expect(acquireWorktreeTerminalSpawn.mock.calls).toEqual([[pane.worktreeId]])
  })

  it('runtime lane refuses to start the process once the requesting client has disconnected (runtime/spawn-execute.ts:65-69,135)', async () => {
    const pane = launchRacePane('guard-disconnect-runtime', '93939393-9393-4393-8393-939393939393')
    const provider = installLaunchRaceProvider(async () => ({ id: 'pty-must-not-spawn' }))
    const abort = new AbortController()
    const runtime = createLaunchRaceRuntime({
      acquireWorktreeTerminalSpawn: vi.fn(async () => {
        // The client socket drops while the spawn waits for the worktree lock.
        abort.abort()
        return () => {}
      })
    })
    const lanes = registerLaunchRaceLanes({ handlers, mainWindow, runtime })

    await expect(lanes.controller.spawn({ ...pane.args, signal: abort.signal })).rejects.toThrow(
      'client_disconnected'
    )
    expect(provider.spawn).not.toHaveBeenCalled()
  })
})
