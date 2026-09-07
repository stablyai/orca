import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import { getWorkspaceWindowNavigationId } from './workspace-window-native-bridge'
import {
  isWorkspaceWindowPresentationKey,
  WORKSPACE_WINDOW_UI_STORAGE_KEY
} from '../../shared/workspace-window-presentation-storage'
import { PAIRING_LOCAL_UI_FIELDS } from '../../shared/pairing-local-ui-fields'
import { flushStagedStateWithDeadline } from '../ipc/renderer-shutdown-checkpoint'

const presentationFields = new Set<string>([
  ...PAIRING_LOCAL_UI_FIELDS,
  'activeView',
  'lastActiveRepoId',
  'lastActiveWorktreeId'
])

export function registerWorkspaceWindowPresentationStorage(getStore: () => Store): void {
  ipcMain.handle('workspaceWindow:presentationFlush', async (event) => {
    getWorkspaceWindowNavigationId(event)
    const result = await flushStagedStateWithDeadline(getStore())
    if (!result.ok) {
      throw new Error('Native presentation checkpoint failed')
    }
  })
  ipcMain.on('workspaceWindow:presentationStorage', (event, key: string, value?: string) => {
    try {
      const windowId = getWorkspaceWindowNavigationId(event)
      if (
        !isWorkspaceWindowPresentationKey(key) ||
        (value !== undefined && typeof value !== 'string')
      ) {
        throw new Error('Invalid presentation storage entry')
      }
      const store = getStore()
      if (value !== undefined) {
        const presentation =
          key === WORKSPACE_WINDOW_UI_STORAGE_KEY
            ? JSON.stringify(
                Object.fromEntries(
                  Object.entries(JSON.parse(value)).filter(([field]) =>
                    presentationFields.has(field)
                  )
                )
              )
            : value
        store.setWorkspaceWindowPresentation(windowId, key, presentation)
      }
      event.returnValue = { value: store.getWorkspaceWindowPresentation(windowId, key) }
    } catch {
      event.returnValue = { error: 'Native presentation storage unavailable' }
    }
  })
}
