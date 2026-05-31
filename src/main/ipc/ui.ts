import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { PersistedUIState } from '../../shared/types'
import { isFeatureInteractionId } from '../../shared/feature-interactions'

export function registerUIHandlers(store: Store): void {
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
