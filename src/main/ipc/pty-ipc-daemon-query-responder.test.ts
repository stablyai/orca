import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers } from './pty'
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

describe('daemon query responder markers', () => {
  const {
    handlers,
    mainWindow,
    installObservableDaemonTestProvider,
    getPtySetHiddenRendererPtyListener
  } = setupPtyIpcSuite()

  it('keeps a revealed view gated until the daemon lets go, then restores it once', async () => {
    vi.useFakeTimers()
    const runtime = {
      setPtyController: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn(() => 42),
      getPtyOutputSequence: vi.fn(() => 42),
      hasRemoteTerminalViewSubscriber: vi.fn(() => false),
      createPreAllocatedTerminalHandle: vi.fn(() => 'terminal-handle-1'),
      registerPreAllocatedHandleForPty: vi.fn(),
      noteDaemonQueryResponderMarker: vi.fn()
    }
    const daemon = installObservableDaemonTestProvider()
    try {
      registerPtyHandlers(mainWindow as never, runtime as never)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: pty:spawn resolves the spawned id.
      const { id } = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        sessionId: 'daemon-session'
      })) as { id: string }
      const setHidden = getPtySetHiddenRendererPtyListener()
      setHidden(null, { id, hidden: true })
      daemon.emitQueryResponderMarker(id, true)
      expect(runtime.noteDaemonQueryResponderMarker).toHaveBeenCalledWith(id, true)
      daemon.emitData(id, 'hidden output')
      vi.advanceTimersByTime(50)
      mainWindow.webContents.send.mockClear()

      setHidden(null, { id, hidden: false })
      daemon.emitData(id, 'answered by the daemon')
      vi.advanceTimersByTime(50)
      expect(mainWindow.webContents.send).not.toHaveBeenCalled()

      daemon.emitQueryResponderMarker(id, false)
      expect(mainWindow.webContents.send.mock.calls).toEqual([
        ['pty:modelRestoreNeeded', { id, reason: 'unhide', markerSeq: 42 }]
      ])
      daemon.emitData(id, 'visible output')
      vi.advanceTimersByTime(50)
      expect(mainWindow.webContents.send).toHaveBeenLastCalledWith(
        'pty:data',
        expect.objectContaining({ id, data: 'visible output' })
      )
      expect(runtime.noteDaemonQueryResponderMarker).toHaveBeenLastCalledWith(id, false)
    } finally {
      vi.useRealTimers()
    }
  })
})
