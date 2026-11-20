import { BrowserWindow } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import type { AgentAwakeService } from '../../power/agent-awake-service'
import { applyAutomaticUpdatesSetting } from '../../updater/updater-service'
import { publishToDocuments } from '../app-registry/app-handler-registry'

export function registerSettingsDocumentBroadcasts(
  store: Store,
  agentAwakeService?: AgentAwakeService
): void {
  agentAwakeService?.subscribe?.((status) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        publishToDocuments('agentAwake:changed', status, { sourceId: window.webContents.id })
      }
    }
  })

  store.onSettingsChanged((updates, _settings, originWebContentsId) => {
    applyAutomaticUpdatesSetting(updates.automaticUpdates)
    for (const window of BrowserWindow.getAllWindows()) {
      const isOrigin =
        originWebContentsId !== undefined && window.webContents.id === originWebContentsId
      if (!window.isDestroyed() && !isOrigin) {
        publishToDocuments('settings:changed', updates, { sourceId: window.webContents.id })
      }
    }
  })
}
