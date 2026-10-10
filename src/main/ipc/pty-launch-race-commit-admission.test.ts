import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { clearProviderPtyState } from './pty/provider/state-cleanup'
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

const SAVE_FAILED = 'ORCA_TERMINAL_SESSION_STATE_SAVE_FAILED'

function failingBindingStore() {
  return {
    persistPtyBinding: vi.fn(async () => {
      throw new Error('disk full')
    })
  }
}

/** The PTY exits while main registers it, so admission rejects the incarnation at commit. */
function exitedDuringRegistrationRuntime() {
  return createLaunchRaceRuntime({
    registerPty: vi.fn(() => {
      throw new Error('agent_session_exited_during_start')
    }),
    getPtyLivenessVerdict: vi.fn(() => ({ status: 'exited' })),
    noteTerminalSpawnCommit: vi.fn(),
    reflowHeadlessTerminalToPtyGrid: vi.fn()
  })
}

// Pins main's current launch behaviour as the convergence parity baseline (commit admission races).
describe('launch race parity: commit admission, both spawn lanes', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()

  it('IPC lane discards the PTY, reports unknown and cancels its pending registration when the binding save fails (ipc/spawn-commit-persist.ts:80-93, ipc/spawn-run.ts:85-91)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const pane = launchRacePane('race-save-fail-ipc', '81818181-8181-4181-8181-818181818181')
    const provider = installLaunchRaceProvider(async () => ({
      id: 'pty-save-fail-ipc',
      incarnationId: 'inc-save-fail-ipc'
    }))
    const runtime = createLaunchRaceRuntime()
    const lanes = registerLaunchRaceLanes({
      handlers,
      mainWindow,
      runtime,
      store: failingBindingStore()
    })

    const spawn = lanes.spawnThroughIpc(pane.args)

    await expect(spawn).rejects.toThrow(SAVE_FAILED)
    await expect(spawn).rejects.toMatchObject({ agentSessionOperationOutcome: 'unknown' })
    expect(provider.shutdown).toHaveBeenCalledWith('pty-save-fail-ipc', {
      immediate: true,
      expectedIncarnationId: 'inc-save-fail-ipc'
    })
    expect(runtime.cancelPendingPtyRegistration).toHaveBeenCalledWith(
      'pty-save-fail-ipc',
      'inc-save-fail-ipc'
    )
  })

  it('runtime lane discards the PTY, reports unknown and cancels its pending registration when the host binding save fails (runtime/spawn-commit.ts:144-175, runtime/spawn.ts:107-113)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const pane = launchRacePane('race-save-fail-runtime', '82828282-8282-4282-8282-828282828282')
    const provider = installLaunchRaceProvider(async () => ({
      id: 'pty-save-fail-runtime',
      incarnationId: 'inc-save-fail-runtime'
    }))
    const runtime = createLaunchRaceRuntime()
    const lanes = registerLaunchRaceLanes({
      handlers,
      mainWindow,
      runtime,
      store: failingBindingStore()
    })

    const spawn = lanes.controller.spawn({ ...pane.args, persistHostSessionBinding: true })

    await expect(spawn).rejects.toThrow(SAVE_FAILED)
    await expect(spawn).rejects.toMatchObject({ agentSessionOperationOutcome: 'unknown' })
    expect(provider.shutdown).toHaveBeenCalledWith('pty-save-fail-runtime', {
      immediate: true,
      expectedIncarnationId: 'inc-save-fail-runtime'
    })
    expect(runtime.cancelPendingPtyRegistration).toHaveBeenCalledWith(
      'pty-save-fail-runtime',
      'inc-save-fail-runtime'
    )
  })

  // Lane drift: IPC resolves with the exited incarnation for the window to drain; runtime rejects (next test).
  it('IPC lane drains an incarnation rejected at registration without publishing or reflowing it (ipc/spawn-commit.ts:83-97, 108-115)', async () => {
    const pane = launchRacePane('race-exited-ipc', '83838383-8383-4383-8383-838383838383')
    installLaunchRaceProvider(async () => ({
      id: 'pty-exited-ipc',
      incarnationId: 'inc-exited-ipc'
    }))
    const runtime = exitedDuringRegistrationRuntime()
    const lanes = registerLaunchRaceLanes({ handlers, mainWindow, runtime })

    await expect(lanes.spawnThroughIpc(pane.args)).resolves.toMatchObject({
      id: 'pty-exited-ipc',
      incarnationId: 'inc-exited-ipc'
    })

    expect(runtime.cancelPendingPtyRegistration).toHaveBeenCalledWith(
      'pty-exited-ipc',
      'inc-exited-ipc'
    )
    expect(runtime.noteTerminalSpawnCommit).not.toHaveBeenCalled()
    expect(runtime.reflowHeadlessTerminalToPtyGrid).not.toHaveBeenCalled()
    clearProviderPtyState('pty-exited-ipc')
  })

  it('runtime lane rejects an incarnation refused at registration without publishing it (runtime/spawn-commit.ts:201-203, runtime/spawn.ts:107-113)', async () => {
    const pane = launchRacePane('race-exited-runtime', '84848484-8484-4484-8484-848484848484')
    installLaunchRaceProvider(async () => ({
      id: 'pty-exited-runtime',
      incarnationId: 'inc-exited-runtime'
    }))
    const runtime = exitedDuringRegistrationRuntime()
    const lanes = registerLaunchRaceLanes({ handlers, mainWindow, runtime })

    await expect(lanes.controller.spawn(pane.args)).rejects.toThrow(
      'agent_session_exited_during_start'
    )

    expect(runtime.cancelPendingPtyRegistration).toHaveBeenCalledWith(
      'pty-exited-runtime',
      'inc-exited-runtime'
    )
    expect(runtime.noteTerminalSpawnCommit).not.toHaveBeenCalled()
    clearProviderPtyState('pty-exited-runtime')
  })

  it('IPC lane reflows the headless model onto the committed grid once admission passes (ipc/spawn-commit.ts:108-115)', async () => {
    const pane = launchRacePane('race-reflow-ipc', '85858585-8585-4585-8585-858585858585')
    installLaunchRaceProvider(async () => ({ id: 'pty-reflow-ipc' }))
    const runtime = createLaunchRaceRuntime({ reflowHeadlessTerminalToPtyGrid: vi.fn() })
    const lanes = registerLaunchRaceLanes({ handlers, mainWindow, runtime })

    await lanes.spawnThroughIpc({ ...pane.args, cols: 132, rows: 40 })

    expect(runtime.reflowHeadlessTerminalToPtyGrid).toHaveBeenCalledWith('pty-reflow-ipc', 132, 40)
    expect(runtime.registerPty.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.reflowHeadlessTerminalToPtyGrid.mock.invocationCallOrder[0]!
    )
    clearProviderPtyState('pty-reflow-ipc')
  })
})
