import { ipcMain } from 'electron'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type {
  RuntimeBrowserDriverState,
  RuntimeStatus,
  RuntimeSyncWindowGraphResult,
  RuntimeSyncWindowGraph,
  RuntimeTerminalDriverState
} from '../../shared/runtime-types'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { getMainWindowForWebContents } from '../window/main-window-registry'

function getSenderWindowId(sender: Electron.WebContents): number {
  const window = getMainWindowForWebContents(sender)
  if (!window) {
    throw new Error('Runtime IPC calls must originate from a BrowserWindow')
  }
  return window.id
}

export function registerRuntimeHandlers(runtime: OrcaRuntimeService): void {
  ipcMain.removeHandler('runtime:syncWindowGraph')
  ipcMain.removeHandler('runtime:getStatus')
  ipcMain.removeHandler('runtime:call')

  ipcMain.handle(
    'runtime:syncWindowGraph',
    (event, graph: RuntimeSyncWindowGraph): RuntimeSyncWindowGraphResult => {
      return runtime.syncWindowGraph(getSenderWindowId(event.sender), graph)
    }
  )

  ipcMain.handle('runtime:getStatus', (): RuntimeStatus => {
    return runtime.getStatus()
  })

  ipcMain.handle(
    'runtime:call',
    async (
      event,
      args: { method: string; params?: unknown }
    ): Promise<RuntimeRpcResponse<unknown>> => {
      const senderWindowId = getSenderWindowId(event.sender)
      return (await new RpcDispatcher({ runtime }).dispatch(
        {
          id: 'desktop-ipc',
          authToken: 'desktop-ipc',
          method: args.method,
          params: args.params
        },
        {
          senderWindowId
        }
      )) as RuntimeRpcResponse<unknown>
    }
  )

  ipcMain.removeHandler('runtime:getTerminalFitOverrides')
  ipcMain.handle(
    'runtime:getTerminalFitOverrides',
    (event): { ptyId: string; mode: 'mobile-fit'; cols: number; rows: number }[] => {
      const senderWindowId = getSenderWindowId(event.sender)
      const overrides = runtime.getAllTerminalFitOverrides()
      return Array.from(overrides.entries())
        .filter(([ptyId]) => runtime.resolveOwnerWindowIdForPtyId(ptyId) === senderWindowId)
        .map(([ptyId, override]) => ({
          ptyId,
          ...override
        }))
    }
  )

  ipcMain.removeHandler('runtime:getTerminalDrivers')
  ipcMain.handle(
    'runtime:getTerminalDrivers',
    (event): { ptyId: string; driver: RuntimeTerminalDriverState }[] => {
      const senderWindowId = getSenderWindowId(event.sender)
      const drivers = runtime.getAllTerminalDrivers()
      return Array.from(drivers.entries())
        .filter(([ptyId]) => runtime.resolveOwnerWindowIdForPtyId(ptyId) === senderWindowId)
        .map(([ptyId, driver]) => ({ ptyId, driver }))
    }
  )

  ipcMain.removeHandler('runtime:getBrowserDrivers')
  ipcMain.handle(
    'runtime:getBrowserDrivers',
    (event): { browserPageId: string; driver: RuntimeBrowserDriverState }[] => {
      const senderWindowId = getSenderWindowId(event.sender)
      const drivers = runtime.getAllBrowserDrivers()
      return Array.from(drivers.entries())
        .filter(
          ([browserPageId]) =>
            runtime.resolveOwnerWindowIdForBrowserPageId(browserPageId) === senderWindowId
        )
        .map(([browserPageId, driver]) => ({
          browserPageId,
          driver
        }))
    }
  )

  // Why: the desktop "Restore" button sets the display mode to 'desktop' and
  // applies it, which restores the PTY to its original dimensions and emits
  // a 'resized' event to any active mobile subscriber. This uses the same
  // code path as the mobile toggle button (terminal.setDisplayMode RPC).
  ipcMain.removeHandler('runtime:restoreTerminalFit')
  ipcMain.handle('runtime:restoreTerminalFit', async (event, args: { ptyId: string }) => {
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
      const senderWindowId = getSenderWindowId(event.sender)
      if (runtime.resolveOwnerWindowIdForPtyId(args.ptyId) !== senderWindowId) {
        return { restored: false }
      }
      const reclaimed = await runtime.reclaimTerminalForDesktop(args.ptyId)
      return { restored: reclaimed }
    } catch {
      return { restored: false }
    }
  })

  ipcMain.removeHandler('runtime:reclaimBrowserForDesktop')
  ipcMain.handle(
    'runtime:reclaimBrowserForDesktop',
    (event, args: { browserPageId: string }): { reclaimed: boolean } => {
      try {
        const senderWindowId = getSenderWindowId(event.sender)
        if (runtime.resolveOwnerWindowIdForBrowserPageId(args.browserPageId) !== senderWindowId) {
          return { reclaimed: false }
        }
        return { reclaimed: runtime.reclaimBrowserForDesktop(args.browserPageId) }
      } catch {
        return { reclaimed: false }
      }
    }
  )
}
