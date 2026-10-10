import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { WORKTREE_TERMINALS_SLEEPING_ERROR } from '../runtime/worktree-terminals-sleeping-error'
import {
  LAUNCH_RACE_LANES,
  createLaunchRaceRuntime,
  installLaunchRaceProvider,
  launchRacePane,
  registerLaunchRaceLanes,
  sleptWorktreeLock,
  type LaunchRaceLane
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

// Pins main's current launch behaviour as the baseline the spawn-lane merge must keep.
describe('launch race parity: slept-worktree and disconnect guards, both spawn lanes', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()

  // Row 13 drift: only the runtime lane passes the refusal to the worktree spawn lock
  // (runtime/spawn-execute.ts:25-30); IPC never does (ipc/spawn-options.ts:238-241), so it wakes.
  const ASKED_TO_REFUSE_SLEPT_WORKTREE: Record<LaunchRaceLane, 'refused' | 'wakes'> = {
    ipc: 'wakes',
    runtime: 'refused'
  }
  it.each(LAUNCH_RACE_LANES)(
    '%s lane: a spawn that asks to refuse a slept worktree',
    async (lane) => {
      const pane = launchRacePane(`guard-slept-${lane}`, '91919191-9191-4191-8191-919191919191')
      const provider = installLaunchRaceProvider(async () => ({ id: `pty-guard-slept-${lane}` }))
      const lock = sleptWorktreeLock()
      lock.refuse()
      const runtime = createLaunchRaceRuntime({
        acquireWorktreeTerminalSpawn: lock.acquireWorktreeTerminalSpawn
      })
      const lanes = registerLaunchRaceLanes({ handlers, mainWindow, runtime })

      const spawn = lanes.spawn[lane]({ ...pane.args, refuseSleptWorktree: true })

      if (ASKED_TO_REFUSE_SLEPT_WORKTREE[lane] === 'refused') {
        await expect(spawn).rejects.toThrow(WORKTREE_TERMINALS_SLEEPING_ERROR)
        expect(provider.spawn).not.toHaveBeenCalled()
      } else {
        await expect(spawn).resolves.toMatchObject({ id: `pty-guard-slept-${lane}` })
        expect(provider.spawn).toHaveBeenCalledOnce()
      }
    }
  )

  // Row 13 (runtime lane only; a client signal cannot cross IPC): runtime/spawn-execute.ts:65-69,135.
  it('runtime lane refuses to start the process once the requesting client has disconnected', async () => {
    const pane = launchRacePane('guard-disconnect', '93939393-9393-4393-8393-939393939393')
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

    await expect(lanes.spawn.runtime({ ...pane.args, signal: abort.signal })).rejects.toThrow(
      'client_disconnected'
    )
    expect(provider.spawn).not.toHaveBeenCalled()
  })
})
