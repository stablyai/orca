import { ipcMain } from 'electron'
import type { AutomationRunOpenTarget } from '../../shared/automation-run-outcome'
import { getTrustedUIRendererWindow } from '../ipc/ui'

let pending: AutomationRunOpenTarget | null = null

export function openAutomationRun(target: AutomationRunOpenTarget): void {
  pending = target
  void import('./main-window-actions')
    .then(({ showMainWindowFromTray }) => {
      showMainWindowFromTray()
      getTrustedUIRendererWindow()?.webContents.send('automations:openRun')
    })
    .catch((error) => console.warn('[automations] Could not reveal notified run:', error))
}

export function registerAutomationRunNavigation(): void {
  ipcMain.removeHandler('automations:consumePendingOpenRun')
  ipcMain.handle('automations:consumePendingOpenRun', (event): AutomationRunOpenTarget | null => {
    if (getTrustedUIRendererWindow()?.webContents.id !== event.sender.id) {
      return null
    }
    const target = pending
    pending = null
    return target
  })
}

export function clearAutomationRunNavigation(): void {
  pending = null
}
