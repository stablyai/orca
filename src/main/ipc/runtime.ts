import { BrowserWindow, ipcMain } from 'electron'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeStatus, RuntimeSyncWindowGraph } from '../../shared/runtime-types'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'

export function registerRuntimeHandlers(runtime: OrcaRuntimeService): void {
  ipcMain.removeHandler('runtime:syncWindowGraph')
  ipcMain.removeHandler('runtime:getStatus')
  ipcMain.removeHandler('runtime:call')

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

  ipcMain.handle(
    'runtime:call',
    async (
      _event,
      args: { method: string; params?: unknown }
    ): Promise<RuntimeRpcResponse<unknown>> => {
      return (await new RpcDispatcher({ runtime }).dispatch({
        id: 'desktop-ipc',
        authToken: 'desktop-ipc',
        method: args.method,
        params: args.params
      })) as RuntimeRpcResponse<unknown>
    }
  )

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
  ipcMain.handle('runtime:restoreTerminalFit', async (_event, args: { ptyId: string }) => {
    // Why: this IPC powers the desktop "Take back" button. Beyond restoring
    // PTY dims (the original semantic), it now also reclaims the input
    // floor for the desktop via the driver state machine. The lock banner
    // unmounts and desktop input/resize are unblocked until the next
    // mobile interaction takes the floor again. See
    // docs/mobile-presence-lock.md.
    //
    // Why async: reclaimTerminalForDesktop awaits applyMobileDisplayMode's
    // PTY-resize chain. Returning the unresolved Promise to ipcMain made
    // Electron try to structured-clone a Promise — "An object could not
    // be cloned" error — and the renderer's restoreTerminalFit() rejected
    // with no useful info.
    try {
      const reclaimed = await runtime.reclaimTerminalForDesktop(args.ptyId)
      return { restored: reclaimed }
    } catch {
      return { restored: false }
    }
  })
}
