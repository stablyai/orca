import { describe, expect, it, vi } from 'vitest'

import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers } from './register-handlers'
import { deletePtyOwnership, setPtyOwnership } from './provider/ownership-state'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../../opencode/status-hooks/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../../agent-hooks/server/agent-hook-server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../../pi/managed-extensions/titlebar-extension-service', () =>
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
vi.mock('../../cli/launchers/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../../agent-hooks/observations/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../../codex/configuration/homes/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../../codex/history/index/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

// Detached relay PTYs outlive their provider; missing providers cannot prove remote exit.
describe('stopping a PTY whose SSH provider is unregistered', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()

  function installController(): {
    controller: {
      kill: (ptyId: string) => boolean
      listProcesses: (hostId?: string) => Promise<{ id: string }[]>
      retireRejectedPty: (
        ptyId: string,
        stopConfirmed: boolean,
        incarnationId: string | undefined
      ) => void
      stopAndWait: (ptyId: string, opts?: { deadlineMs?: number }) => Promise<boolean>
    }
    runtime: {
      setPtyController: ReturnType<typeof vi.fn>
      onPtyExit: ReturnType<typeof vi.fn>
      markPtyLivenessUnverifiable: ReturnType<typeof vi.fn>
      markPtyLivenessLive: ReturnType<typeof vi.fn>
    }
  } {
    const runtime = {
      setPtyController: vi.fn(),
      onPtyExit: vi.fn(),
      markPtyLivenessUnverifiable: vi.fn(),
      markPtyLivenessLive: vi.fn()
    }
    handlers.clear()
    registerPtyHandlers(mainWindow as never, runtime as never)
    return {
      controller: runtime.setPtyController.mock.calls[0]?.[0] as never,
      runtime
    }
  }

  it('reports an unconfirmed exact stop instead of a fabricated teardown', async () => {
    setPtyOwnership('ssh-detached-stop', 'ssh:ssh-dropped')
    const { controller, runtime } = installController()

    await expect(controller.stopAndWait('ssh-detached-stop')).resolves.toBe(false)
    expect(runtime.onPtyExit).toHaveBeenCalledWith('ssh-detached-stop', -1, undefined)
    expect(runtime.markPtyLivenessUnverifiable).toHaveBeenCalledWith(
      'ssh-detached-stop',
      expect.stringContaining('SSH')
    )
    deletePtyOwnership('ssh-detached-stop')
  })
})
