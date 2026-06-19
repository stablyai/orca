import { BrowserWindow, ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { PersistedUIState } from '../../shared/types'
import { isFeatureInteractionId } from '../../shared/feature-interactions'

export function registerUIHandlers(store: Store): void {
  // Why: UI view-state is shared between the desktop renderer and mobile (ui.set
  // RPC). Broadcast every change so the desktop re-hydrates when mobile (or
  // another window) updates it — bi-directional sync, mirroring settings:changed.
  store.onUIChanged((ui) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('ui:stateChanged', ui)
      }
    }
  })

  ipcMain.handle('ui:get', () => {
    return store.getUI()
  })

  ipcMain.handle('ui:set', (_event, args: Partial<PersistedUIState>) => {
    store.updateUI(args)
  })

  ipcMain.handle('ui:recordFeatureInteraction', (_event, id: unknown) => {
    if (!isFeatureInteractionId(id)) {
      throw new Error('invalid_feature_interaction_id')
    }
    return store.recordFeatureInteraction(id)
  })
}
