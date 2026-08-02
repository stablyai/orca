import { ipcMain } from 'electron'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { PersistedUIState, WorkspaceSessionState } from '../../shared/types'
import type { Store } from '../persistence'

type StageBeforeUnloadSyncArgs = {
  sessions: { state: WorkspaceSessionState; hostId?: ExecutionHostId }[]
  ui: Partial<PersistedUIState>
}

export function registerRendererShutdownCheckpointHandler(store: Store): void {
  ipcMain.on('app:stage-before-unload-sync', (event, args: StageBeforeUnloadSyncArgs) => {
    let ok = true
    try {
      for (const { state, hostId } of args.sessions) {
        store.stageWorkspaceSessionBeforeUnload(state, hostId)
      }
      store.updateUI(args.ui)
    } catch (error) {
      console.error('[app] Failed to stage renderer state before unload:', error)
      ok = false
    }
    if (ok) {
      void store.flushPendingAsync().catch((error) => {
        console.error('[app] Failed to persist staged renderer state:', error)
      })
    }
    event.returnValue = { ok }
  })
}
