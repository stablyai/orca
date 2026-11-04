import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { clearProviderPtyState } from './provider/state-cleanup'
import {
  LAUNCH_RACE_LANES,
  createLaunchRaceRuntime,
  registerLaunchRaceLanes
} from './pty-launch-race-test-fixture'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node:fs/promises', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).fsPromisesModuleMock(await importOriginal())
)
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
vi.mock('../../pty/shell-startup/pwsh', () =>
  import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock())
)
vi.mock('../../wsl/filesystem/unc-path-access', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
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
vi.mock('../../codex/configuration/homes/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../../codex/history/index/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

describe('Claude profile launches on both spawn lanes', () => {
  const { handlers, mainWindow, installDaemonTestProvider } = setupPtyIpcSuite()

  it.each(LAUNCH_RACE_LANES)(
    '%s lane: a Claude profile launch keeps its folder instead of the selected account',
    async (lane) => {
      const id = `claude-profile-${lane}`
      const configDir = await mkdtemp(join(tmpdir(), 'claude-profile-'))
      onTestFinished(() => rm(configDir, { recursive: true, force: true }))
      const spawn = vi.fn(async () => ({ id }))
      installDaemonTestProvider({ spawn })
      const lanes = registerLaunchRaceLanes({
        handlers,
        mainWindow,
        runtime: createLaunchRaceRuntime(),
        prepareClaudeAuth: async () => ({
          configDir: '/accounts/selected',
          runtime: 'host',
          wslDistro: null,
          wslLinuxConfigDir: null,
          envPatch: { CLAUDE_CONFIG_DIR: '/accounts/selected' },
          provenance: 'profile:selected'
        })
      })
      await lanes.spawn[lane]({
        cols: 80,
        rows: 24,
        sessionId: id,
        command: 'claude',
        env: { CLAUDE_CONFIG_DIR: configDir, ORCA_CLAUDE_CONFIG_PROFILE_DIR: configDir }
      })
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({ env: expect.objectContaining({ CLAUDE_CONFIG_DIR: configDir }) })
      )
      clearProviderPtyState(id)
    }
  )
})
