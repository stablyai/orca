import { describe, expect, it, vi } from 'vitest'
import { SSH_PROVIDER_UNREGISTERED_REASON } from '../../shared/pty-liveness-verdict'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import {
  registerPtyHandlers,
  deletePtyOwnership,
  setPtyOwnership,
  getLocalPtyProvider,
  registerSshPtyProvider,
  unregisterSshPtyProvider
} from './pty'

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
      listProcesses: (connectionId?: string | null) => Promise<{ id: string }[]>
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
    setPtyOwnership('ssh-detached-pty', 'ssh-dropped')
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
    setPtyOwnership('ssh-detached-stop', 'ssh-dropped')
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
    setPtyOwnership(ptyId, 'ssh-dropped')
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
    setPtyOwnership(ptyId, 'ssh-dropped')
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

  it('records provider-confirmed absence when the exit event was missed', async () => {
    const connectionId = 'ssh-confirmed-absent'
    const ptyId = 'ssh-confirmed-absent-pty'
    const provider = {
      onExit: vi.fn(() => () => {}),
      shutdown: vi.fn(async () => {}),
      listProcesses: vi.fn(async () => [])
    }
    registerSshPtyProvider(connectionId, provider as never)
    setPtyOwnership(ptyId, connectionId)
    try {
      const { controller, runtime } = installController()

      await expect(controller.stopAndWait(ptyId)).resolves.toBe(true)
      expect(runtime.onPtyExit).toHaveBeenCalledWith(ptyId, 0, undefined)
      expect(runtime.markPtyLivenessUnverifiable).not.toHaveBeenCalled()
    } finally {
      deletePtyOwnership(ptyId)
      unregisterSshPtyProvider(connectionId)
    }
  })

  it('reports lost contact when a registered provider drops during the stop', async () => {
    const connectionId = 'ssh-mid-stop-drop'
    const ptyId = 'ssh-mid-stop-pty'
    const provider = {
      onExit: vi.fn(() => () => {}),
      shutdown: vi.fn(async () => {
        throw new Error('relay disconnected during stop')
      })
    }
    registerSshPtyProvider(connectionId, provider as never)
    setPtyOwnership(ptyId, connectionId)
    try {
      const { controller, runtime } = installController()

      await expect(controller.stopAndWait(ptyId)).resolves.toBe(false)
      expect(runtime.markPtyLivenessUnverifiable).toHaveBeenCalledWith(
        ptyId,
        'relay disconnected during stop'
      )
    } finally {
      deletePtyOwnership(ptyId)
      unregisterSshPtyProvider(connectionId)
    }
  })

  it('preserves lost-contact evidence when fire-and-forget shutdown rejects', async () => {
    const connectionId = 'ssh-async-kill-drop'
    const ptyId = 'ssh-async-kill-pty'
    const provider = {
      onExit: vi.fn(() => () => {}),
      shutdown: vi.fn(async () => {
        throw new Error('relay disconnected during kill')
      })
    }
    registerSshPtyProvider(connectionId, provider as never)
    setPtyOwnership(ptyId, connectionId)
    try {
      const { controller, runtime } = installController()

      expect(controller.kill(ptyId)).toBe(true)
      await vi.waitFor(() =>
        expect(runtime.markPtyLivenessUnverifiable).toHaveBeenCalledWith(
          ptyId,
          'relay disconnected during kill'
        )
      )
      expect(runtime.onPtyExit).toHaveBeenCalledWith(ptyId, -1, undefined)
    } finally {
      deletePtyOwnership(ptyId)
      unregisterSshPtyProvider(connectionId)
    }
  })

  it('isolates a failed SSH inventory from healthy providers', async () => {
    const failedConnectionId = 'ssh-inventory-failed'
    const healthyConnectionId = 'ssh-inventory-healthy'
    const failedPtyId = 'ssh-inventory-failed-pty'
    const healthyPtyId = 'ssh-inventory-healthy-pty'
    registerSshPtyProvider(failedConnectionId, {
      listProcesses: vi.fn(async () => {
        throw new Error('inventory transport failed')
      })
    } as never)
    registerSshPtyProvider(healthyConnectionId, {
      listProcesses: vi.fn(async () => [{ id: healthyPtyId }])
    } as never)
    setPtyOwnership(failedPtyId, failedConnectionId)
    setPtyOwnership(healthyPtyId, healthyConnectionId)
    try {
      const { controller, runtime } = installController()

      await expect(controller.listProcesses()).resolves.toEqual(
        expect.arrayContaining([{ id: healthyPtyId }])
      )
      expect(runtime.markPtyLivenessUnverifiable).toHaveBeenCalledWith(
        failedPtyId,
        'inventory transport failed'
      )
      expect(runtime.markPtyLivenessUnverifiable).not.toHaveBeenCalledWith(
        healthyPtyId,
        expect.anything()
      )
    } finally {
      deletePtyOwnership(failedPtyId)
      deletePtyOwnership(healthyPtyId)
      unregisterSshPtyProvider(failedConnectionId)
      unregisterSshPtyProvider(healthyConnectionId)
    }
  })

  it('reports a provider-observed survivor as live', async () => {
    const connectionId = 'ssh-still-live'
    const ptyId = 'ssh-still-live-pty'
    const provider = {
      onExit: vi.fn(() => () => {}),
      shutdown: vi.fn(async () => {}),
      listProcesses: vi.fn(async () => [{ id: ptyId }])
    }
    registerSshPtyProvider(connectionId, provider as never)
    setPtyOwnership(ptyId, connectionId)
    try {
      const { controller, runtime } = installController()

      await expect(controller.stopAndWait(ptyId)).resolves.toBe(false)
      expect(runtime.markPtyLivenessLive).toHaveBeenCalledWith(ptyId)
    } finally {
      deletePtyOwnership(ptyId)
      unregisterSshPtyProvider(connectionId)
    }
  })
})
