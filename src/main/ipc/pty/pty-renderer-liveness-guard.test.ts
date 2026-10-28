import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { PtyWriteUnavailableError } from '../../providers/pty-write-unavailable-error'
import { TERMINAL_INPUT_CHUNK_MAX_BYTES } from '../../../shared/terminal-input'
import { registerPtyHandlers } from './register-handlers'
import { subscribeToPtyEndpointLoss } from '../../runtime/terminal/pty-endpoint-loss-signal'

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

/** WebContents can die before its BrowserWindow; unguarded sends then throw in main and kill every terminal (STA-2373, STA-5373). */
describe('pty:writeUnavailable renderer-liveness guard', () => {
  const {
    handlers,
    mainWindow,
    mainWindowIpcEvent,
    installDaemonTestProvider,
    getPtyWriteListener
  } = setupPtyIpcSuite()

  async function spawnDaemonPty(): Promise<string> {
    const result = (await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })) as {
      id: string
    }
    mainWindow.webContents.send.mockClear()
    return result.id
  }

  describe('the per-write sender', () => {
    it('asks the renderer to remount while the WebContents is alive', async () => {
      installDaemonTestProvider({
        write: vi.fn(() => {
          throw new PtyWriteUnavailableError('daemon generation lost')
        })
      })
      registerPtyHandlers(mainWindow as never)
      const id = await spawnDaemonPty()

      getPtyWriteListener()(mainWindowIpcEvent, { id, data: 'x' })

      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:writeUnavailable', { id })
    })

    // Multi-chunk writes yield after the sender check, allowing WebContents to die before a later write fails.
    it('stays silent when the WebContents dies mid-write under a live window', async () => {
      let writeCount = 0
      installDaemonTestProvider({
        write: vi.fn(() => {
          writeCount += 1
          if (writeCount < 2) {
            return
          }
          mainWindow.webContents.isDestroyed.mockReturnValue(true)
          throw new PtyWriteUnavailableError('daemon generation lost')
        })
      })
      registerPtyHandlers(mainWindow as never)
      const id = await spawnDaemonPty()

      getPtyWriteListener()(mainWindowIpcEvent, {
        id,
        data: 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES * 3)
      })
      // The chunk loop yields a macrotask between chunks; wait for the failing one.
      await vi.waitFor(() => expect(writeCount).toBeGreaterThan(1))

      expect(mainWindow.webContents.isDestroyed).toHaveBeenCalled()
      expect(mainWindow.webContents.send).not.toHaveBeenCalledWith(
        'pty:writeUnavailable',
        expect.anything()
      )
    })
  })

  describe('the daemon-death fan-out', () => {
    function installProviderCapturingFanout(): (payload: { id: string }) => void {
      let fanout: ((payload: { id: string }) => void) | null = null
      installDaemonTestProvider({
        onWriteUnavailable: vi.fn((callback: (payload: { id: string }) => void) => {
          fanout = callback
          return () => {}
        })
      })
      registerPtyHandlers(mainWindow as never)
      if (!fanout) {
        throw new Error('registerPtyHandlers did not subscribe to onWriteUnavailable')
      }
      return fanout
    }

    it('remounts every signalled pane while the WebContents is alive', () => {
      const fanout = installProviderCapturingFanout()

      fanout({ id: 'pane-1' })

      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:writeUnavailable', {
        id: 'pane-1'
      })
    })

    it('stays silent when the WebContents is destroyed under a live window', () => {
      const fanout = installProviderCapturingFanout()
      mainWindow.webContents.isDestroyed.mockReturnValue(true)

      fanout({ id: 'pane-1' })

      expect(mainWindow.webContents.isDestroyed).toHaveBeenCalled()
      expect(mainWindow.webContents.send).not.toHaveBeenCalledWith(
        'pty:writeUnavailable',
        expect.anything()
      )
    })

    it('reaches remote terminal streams without a live window', () => {
      // Headless clients depend on streams even when no renderer can receive the event.
      const fanout = installProviderCapturingFanout()
      mainWindow.webContents.isDestroyed.mockReturnValue(true)
      const streamListener = vi.fn()
      const unsubscribe = subscribeToPtyEndpointLoss('pane-1', streamListener)
      try {
        fanout({ id: 'pane-1' })
        expect(streamListener).toHaveBeenCalledOnce()
      } finally {
        unsubscribe()
      }
    })
  })
})
