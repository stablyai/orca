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
    try {
      // Why: apply both renderer-owned snapshots before synchronously flushing
      // each owning store, so an immediate exit cannot outrun either update.
      for (const { state, hostId } of args.sessions) {
        store.setWorkspaceSession(state, hostId)
      }
      store.updateUI(args.ui)
      store.flushOrThrow()
      store.flushActiveViewPreferenceOrThrow()
      event.returnValue = { ok: true }
    } catch (error) {
      console.error('[app] Failed to persist renderer state before unload:', error)
      event.returnValue = { ok: false }
    }
  })
}
