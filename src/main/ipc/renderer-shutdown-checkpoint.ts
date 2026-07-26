import { ipcMain } from 'electron'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { PersistedUIState, WorkspaceSessionState } from '../../shared/types'
import type { Store } from '../persistence'

type PersistBeforeUnloadSyncArgs = {
  sessions: { state: WorkspaceSessionState; hostId?: ExecutionHostId }[]
  ui: Partial<PersistedUIState>
}

export function registerRendererShutdownCheckpointHandler(store: Store): void {
  ipcMain.on('app:persist-before-unload-sync', (event, args: PersistBeforeUnloadSyncArgs) => {
    let ok = true
    // Why: apply both renderer-owned snapshots before synchronously flushing
    // each owning store, so an immediate exit cannot outrun either update.
    try {
      for (const { state, hostId } of args.sessions) {
        store.setWorkspaceSession(state, hostId)
      }
      store.updateUI(args.ui)
    } catch (error) {
      console.error('[app] Failed to stage renderer state before unload:', error)
      ok = false
    }
    // Why: the durable snapshot and the active-view sidecar are independent stores;
    // flush each on its own so one store's failure can't skip the other's checkpoint.
    try {
      store.flushOrThrow()
    } catch (error) {
      console.error('[app] Failed to flush durable state before unload:', error)
      ok = false
    }
    try {
      store.flushActiveViewPreferenceOrThrow()
    } catch (error) {
      console.error('[app] Failed to flush active-view preference before unload:', error)
      ok = false
    }
    event.returnValue = { ok }
  })
}
