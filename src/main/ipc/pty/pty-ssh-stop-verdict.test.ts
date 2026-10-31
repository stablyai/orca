import { describe, expect, it, vi } from 'vitest'
import { SSH_PROVIDER_UNREGISTERED_REASON } from '../../../shared/pty-liveness-verdict'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers } from './register-handlers'
import {
  deletePtyOwnership,
  ptyIncarnationById,
  ptyOwnership,
  setPtyOwnership
} from './provider/ownership-state'

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
      controller.retireRejectedPty(ptyId, false, undefined)

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

  it('leaves a same-id respawn alone when the rejected incarnation is retired', () => {
    const ptyId = 'ssh-respawned-split'
    // The rejected spawn's stop already retired its incarnation; a respawn took the id since.
    setPtyOwnership(ptyId, 'ssh:ssh-live')
    ptyIncarnationById.set(ptyId, 'inc-respawn')
    const { controller, runtime } = installController()
    try {
      controller.retireRejectedPty(ptyId, true, 'inc-rejected')
      controller.retireRejectedPty(ptyId, false, 'inc-rejected')

      expect(ptyOwnership.get(ptyId)).toBe('ssh:ssh-live')
      expect(ptyIncarnationById.get(ptyId)).toBe('inc-respawn')
      expect(runtime.onPtyExit).not.toHaveBeenCalled()
      expect(runtime.markPtyLivenessUnverifiable).not.toHaveBeenCalled()
    } finally {
      ptyIncarnationById.delete(ptyId)
      deletePtyOwnership(ptyId)
    }
  })
})
