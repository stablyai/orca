import { ipcMain, type WebContents } from 'electron'
import { taskNoteMutationSchema } from '../../shared/dashboard-task-notes'
import type { Store } from '../persistence/loading-store/store'
import {
  getDashboardPopoutWindow,
  isDashboardPopoutRenderer
} from '../window/dashboard-popout-window'
import { isTrustedUIRenderer, sendToTrustedUIRenderer } from './ui'

export function registerDashboardTaskNoteHandlers(store: Store): void {
  const authorize = (sender: WebContents): void => {
    if (
      (!isTrustedUIRenderer(sender) && !isDashboardPopoutRenderer(sender)) ||
      store.getSettings().experimentalAgentDashboardPopout !== true
    ) {
      throw new Error('Dashboard task notes are unavailable to this renderer')
    }
  }
  ipcMain.removeHandler('dashboard:taskNotes:get')
  ipcMain.removeHandler('dashboard:taskNotes:set')
  ipcMain.handle('dashboard:taskNotes:get', (event) => {
    authorize(event.sender)
    return store.loadDashboardTaskNotes()
  })
  ipcMain.handle('dashboard:taskNotes:set', async (event, input: unknown) => {
    authorize(event.sender)
    const change = await store.setDashboardTaskNote(taskNoteMutationSchema.parse(input))
    sendToTrustedUIRenderer('dashboard:taskNotes:changed', change)
    getDashboardPopoutWindow()?.webContents.send('dashboard:taskNotes:changed', change)
    return change
  })
}
