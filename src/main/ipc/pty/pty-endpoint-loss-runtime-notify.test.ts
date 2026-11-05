import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
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

describe('pty:writeUnavailable daemon-death fan-out', () => {
  const { mainWindow, installDaemonTestProvider } = setupPtyIpcSuite()

  it('tells the runtime, which re-attaches the terminal for its remote views', () => {
    let fanout: ((payload: { id: string }) => void) | null = null
    installDaemonTestProvider({
      onWriteUnavailable: vi.fn((callback: (payload: { id: string }) => void) => {
        fanout = callback
        return () => {}
      })
    })
    const runtime = new OrcaRuntimeService()
    const notePtyEndpointLoss = vi.spyOn(runtime, 'notePtyEndpointLoss')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a mocked BrowserWindow; the handlers reach only its webContents, which the mock provides.
    registerPtyHandlers(mainWindow as never, runtime)
    mainWindow.webContents.isDestroyed.mockReturnValue(true)

    fanout!({ id: 'pane-1' })

    expect(notePtyEndpointLoss).toHaveBeenCalledWith('pane-1')
  })
})
