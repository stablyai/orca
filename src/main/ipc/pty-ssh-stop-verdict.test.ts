import { describe, expect, it, vi } from 'vitest'
import { SSH_PROVIDER_UNREGISTERED_REASON } from '../../shared/pty-liveness-verdict'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers } from './pty/register-handlers'
import { deletePtyOwnership, setPtyOwnership } from './pty/provider/ownership-state'
import { getLocalPtyProvider } from './pty/provider/registry'

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

// A detached relay PTY is designed to outlive the provider that addressed it, so
// "the SSH provider is gone" is never evidence that the remote process stopped.
describe('stopping a PTY whose SSH provider is unregistered', () => {
  const { handlers, mainWindow, installObservableDaemonTestProvider } = setupPtyIpcSuite()

  function installController(): {
    controller: {
      kill: (ptyId: string) => boolean
      listProcesses: (hostId?: string) => Promise<{ id: string }[]>
      retireRejectedPty: (ptyId: string, stopConfirmed: boolean) => void
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

  it('reports an unconfirmed stop instead of a fabricated kill', () => {
    setPtyOwnership('ssh-detached-pty', 'ssh:ssh-dropped')
    const { controller, runtime } = installController()

    expect(controller.kill('ssh-detached-pty')).toBe(false)
    // The local lease is still tombstoned so reconnect cannot revive the pane.
    expect(runtime.onPtyExit).toHaveBeenCalledWith('ssh-detached-pty', -1, undefined)
    expect(runtime.markPtyLivenessUnverifiable).toHaveBeenCalledWith(
      'ssh-detached-pty',
      expect.stringContaining('SSH')
    )
    deletePtyOwnership('ssh-detached-pty')
  })

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

  it('preserves lost-contact evidence for renderer IPC teardown', async () => {
    const ptyId = 'ssh-renderer-detached'
    setPtyOwnership(ptyId, 'ssh:ssh-dropped')
    const { runtime } = installController()
    try {
      await handlers.get('pty:kill')!(null, { id: ptyId })

      expect(runtime.markPtyLivenessUnverifiable).toHaveBeenCalledWith(
        ptyId,
        SSH_PROVIDER_UNREGISTERED_REASON
      )
      expect(runtime.onPtyExit).toHaveBeenCalledWith(ptyId, -1, undefined)
    } finally {
      deletePtyOwnership(ptyId)
    }
  })

  it('retires a rejected split without asserting an unconfirmed exit', () => {
    const ptyId = 'ssh-rejected-split'
    setPtyOwnership(ptyId, 'ssh:ssh-dropped')
    const { controller, runtime } = installController()
    try {
      controller.retireRejectedPty(ptyId, false)

      expect(runtime.markPtyLivenessUnverifiable).toHaveBeenCalledWith(
        ptyId,
        'a follow-up stop was issued but its outcome could not be verified'
      )
      expect(runtime.onPtyExit).toHaveBeenCalledWith(ptyId, -1, undefined)
      expect(runtime.onPtyExit).not.toHaveBeenCalledWith(ptyId, 0, expect.anything())
    } finally {
      deletePtyOwnership(ptyId)
    }
  })

  it('still confirms a stop the owning provider actually performed', async () => {
    const daemon = installObservableDaemonTestProvider()
    vi.spyOn(getLocalPtyProvider(), 'listProcesses').mockResolvedValue([])
    const { controller, runtime } = installController()

    await expect(controller.stopAndWait('wt-1@@local-session')).resolves.toBe(true)
    expect(daemon.shutdown).toHaveBeenCalledWith(
      'wt-1@@local-session',
      expect.objectContaining({ immediate: true })
    )
    expect(runtime.markPtyLivenessUnverifiable).not.toHaveBeenCalled()
  })
})
