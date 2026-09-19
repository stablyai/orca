import { canCreateRendererSessionPartition } from './renderer-workspace-session-admission'
import { ipcMain } from 'electron'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { retireEmptyTerminalTab } from './session-empty-terminal-tab-retirement'
import type { Store } from '../persistence'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../shared/workspace-session-state-types'

export function registerSessionHandlers(store: Store, runtime: OrcaRuntimeService): void {
  ipcMain.handle('session:retire-empty-terminal-tab', (_event, args: unknown) => {
    return retireEmptyTerminalTab(store, runtime, args)
  })

  // Why: hostId is an optional second arg so an older renderer that invokes
  // these channels without it keeps reading/writing the 'local' partition
  // exactly as before. Channel names stay stable.
  ipcMain.handle('session:get', (_event, hostId?: string | null) => {
    return store.getWorkspaceSession(hostId)
  })

  ipcMain.handle('session:set', (_event, args: WorkspaceSessionState, hostId?: string | null) => {
    if (isRendererSessionAdmitted(store, hostId)) {
      store.setWorkspaceSession(args, hostId)
    }
  })

  ipcMain.handle('session:patch', (_event, args: WorkspaceSessionPatch, hostId?: string | null) => {
    if (isRendererSessionAdmitted(store, hostId)) {
      store.patchWorkspaceSession(args, hostId)
    }
  })

  ipcMain.handle('session:flush', () => {
    // Why: durable lifecycle RPCs must propagate disk failures instead of
    // returning success through Store.flush(), which intentionally only logs.
    store.flushOrThrow()
  })

  // Synchronous variant for the renderer's beforeunload handler.
  // sendSync blocks the renderer until this returns, guaranteeing the
  // data (including terminal scrollback buffers) is persisted to disk
  // before the window closes — regardless of before-quit ordering.
  ipcMain.on('session:set-sync', (event, args: WorkspaceSessionState, hostId?: string | null) => {
    let admitted = false
    let admissionOk = true
    try {
      admitted = canCreateRendererSessionPartition(store, hostId)
    } catch (error) {
      console.error('[session] Failed to establish runtime session partition authority:', error)
      admissionOk = false
    }
    if (admitted) {
      store.setWorkspaceSession(args, hostId)
    }
    store.flush()
    event.returnValue = admissionOk
  })

  ipcMain.on(
    'session:read-terminal-scrollback-sync',
    (event, args: { ref?: unknown } | undefined) => {
      event.returnValue =
        typeof args?.ref === 'string' ? store.readTerminalScrollbackSnapshot(args.ref) : null
    }
  )
}

function isRendererSessionAdmitted(store: Store, hostId?: string | null): boolean {
  try {
    return canCreateRendererSessionPartition(store, hostId)
  } catch (error) {
    console.error('[session] Failed to establish runtime session partition authority:', error)
    return false
  }
}
