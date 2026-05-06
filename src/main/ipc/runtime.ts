import { BrowserWindow, ipcMain } from 'electron'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeStatus, RuntimeSyncWindowGraph } from '../../shared/runtime-types'

export function registerRuntimeHandlers(runtime: OrcaRuntimeService): void {
  ipcMain.removeHandler('runtime:syncWindowGraph')
  ipcMain.removeHandler('runtime:getStatus')

  ipcMain.handle(
    'runtime:syncWindowGraph',
    (event, graph: RuntimeSyncWindowGraph): RuntimeStatus => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) {
        throw new Error('Runtime graph sync must originate from a BrowserWindow')
      }
      return runtime.syncWindowGraph(window.id, graph)
    }
  )

  ipcMain.handle('runtime:getStatus', (): RuntimeStatus => {
    return runtime.getStatus()
  })

  ipcMain.removeHandler('runtime:getTerminalFitOverrides')
  ipcMain.handle(
    'runtime:getTerminalFitOverrides',
    (): { ptyId: string; mode: 'mobile-fit'; cols: number; rows: number }[] => {
      const overrides = runtime.getAllTerminalFitOverrides()
      return Array.from(overrides.entries()).map(([ptyId, override]) => ({
        ptyId,
        ...override
      }))
    }
  )

  // Why: the desktop "Restore" button sets the display mode to 'desktop' and
  // applies it, which restores the PTY to its original dimensions and emits
  // a 'resized' event to any active mobile subscriber. This uses the same
  // code path as the mobile toggle button (terminal.setDisplayMode RPC).
  ipcMain.removeHandler('runtime:restoreTerminalFit')
  ipcMain.handle('runtime:restoreTerminalFit', (_event, args: { ptyId: string }) => {
    // Why: this IPC powers the desktop "Take back" button. Beyond restoring
    // PTY dims (the original semantic), it now also reclaims the input
    // floor for the desktop via the driver state machine. The lock banner
    // unmounts and desktop input/resize are unblocked until the next
    // mobile interaction takes the floor again. See
    // docs/mobile-presence-lock.md.
    try {
      const reclaimed = runtime.reclaimTerminalForDesktop(args.ptyId)
      return { restored: reclaimed }
    } catch {
      return { restored: false }
    }
  })
}
