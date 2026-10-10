import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { clearProviderPtyState } from './pty/provider/state-cleanup'
import {
  LAUNCH_RACE_LANES,
  createLaunchRaceRuntime,
  installLaunchRaceProvider,
  launchRacePane,
  registerLaunchRaceLanes,
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

function forgetPtyAfterTest(ptyId: string): void {
  onTestFinished(() => clearProviderPtyState(ptyId))
}

// Pins main's current launch behaviour as the baseline the spawn-lane merge must keep.
describe('launch race parity: saving and admitting the new process, both spawn lanes', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()

  // Rows 8 + 11: a failed binding save discards the new PTY, reports the outcome as unknown and
  // cancels its pending registration (ipc/spawn-commit-persist.ts:80-93 with ipc/spawn-run.ts:85-91;
  // runtime/spawn-commit.ts:144-175 with runtime/spawn.ts:107-113). Only the runtime lane needs
  // asking to save a host binding.
  const SAVE_BINDING_ARGS: Record<LaunchRaceLane, Record<string, unknown>> = {
    ipc: {},
    runtime: { persistHostSessionBinding: true }
  }
  it.each(LAUNCH_RACE_LANES)(
    '%s lane: a failed binding save discards the PTY and reports the outcome as unknown',
    async (lane) => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
      onTestFinished(() => errorLog.mockRestore())
      const pane = launchRacePane(`race-save-fail-${lane}`, '81818181-8181-4181-8181-818181818181')
      const ptyId = `pty-save-fail-${lane}`
      const provider = installLaunchRaceProvider(async () => ({
        id: ptyId,
        incarnationId: 'inc-1'
      }))
      const runtime = createLaunchRaceRuntime()
      const store = {
        persistPtyBinding: vi.fn(async () => {
          throw new Error('disk full')
        })
      }
      const lanes = registerLaunchRaceLanes({ handlers, mainWindow, runtime, store })
      forgetPtyAfterTest(ptyId)

      const spawn = lanes.spawn[lane]({ ...pane.args, ...SAVE_BINDING_ARGS[lane] })

      await expect(spawn).rejects.toThrow('ORCA_TERMINAL_SESSION_STATE_SAVE_FAILED')
      await expect(spawn).rejects.toMatchObject({ agentSessionOperationOutcome: 'unknown' })
      expect(provider.shutdown).toHaveBeenCalledWith(ptyId, {
        immediate: true,
        expectedIncarnationId: 'inc-1'
      })
      expect(runtime.cancelPendingPtyRegistration).toHaveBeenCalledWith(ptyId, 'inc-1')
    }
  )

  // Rows 8 + 10 drift: an incarnation that exits while main registers it is never published or
  // resized on either lane, but IPC hands it back for the window to drain (ipc/spawn-commit.ts:83-97)
  // while the runtime lane rejects (runtime/spawn-commit.ts:201-203 with runtime/spawn.ts:107-113).
  const EXITED_DURING_REGISTRATION: Record<LaunchRaceLane, 'resolves' | 'rejects'> = {
    ipc: 'resolves',
    runtime: 'rejects'
  }
  it.each(LAUNCH_RACE_LANES)(
    '%s lane: an incarnation that exits while it is registered',
    async (lane) => {
      const pane = launchRacePane(`race-exited-${lane}`, '83838383-8383-4383-8383-838383838383')
      const ptyId = `pty-exited-${lane}`
      installLaunchRaceProvider(async () => ({ id: ptyId, incarnationId: 'inc-exited' }))
      const runtime = createLaunchRaceRuntime({
        registerPty: vi.fn(() => {
          throw new Error('agent_session_exited_during_start')
        }),
        getPtyLivenessVerdict: vi.fn(() => ({ status: 'exited' }))
      })
      const lanes = registerLaunchRaceLanes({ handlers, mainWindow, runtime })
      forgetPtyAfterTest(ptyId)

      const spawn = lanes.spawn[lane](pane.args)

      await (EXITED_DURING_REGISTRATION[lane] === 'resolves'
        ? expect(spawn).resolves.toMatchObject({ id: ptyId, incarnationId: 'inc-exited' })
        : expect(spawn).rejects.toThrow('agent_session_exited_during_start'))
      expect(runtime.cancelPendingPtyRegistration).toHaveBeenCalledWith(ptyId, 'inc-exited')
      expect(runtime.noteTerminalSpawnCommit).not.toHaveBeenCalled()
      expect(runtime.reflowHeadlessTerminalToPtyGrid).not.toHaveBeenCalled()
    }
  )

  // Row 10: the model is resized only after admission (ipc/spawn-commit.ts:59 then :108-115;
  // runtime/spawn-commit.ts:178 then :230).
  it.each(LAUNCH_RACE_LANES)(
    '%s lane: an admitted spawn resizes the model to its grid after registering it',
    async (lane) => {
      const pane = launchRacePane(`race-reflow-${lane}`, '85858585-8585-4585-8585-858585858585')
      const ptyId = `pty-reflow-${lane}`
      installLaunchRaceProvider(async () => ({ id: ptyId }))
      const runtime = createLaunchRaceRuntime()
      const lanes = registerLaunchRaceLanes({ handlers, mainWindow, runtime })
      forgetPtyAfterTest(ptyId)

      await lanes.spawn[lane]({ ...pane.args, cols: 132, rows: 40 })

      expect(runtime.reflowHeadlessTerminalToPtyGrid).toHaveBeenCalledWith(ptyId, 132, 40)
      expect(runtime.registerPty.mock.invocationCallOrder[0]).toBeLessThan(
        runtime.reflowHeadlessTerminalToPtyGrid.mock.invocationCallOrder[0]!
      )
    }
  )
})
