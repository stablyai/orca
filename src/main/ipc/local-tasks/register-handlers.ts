import { ipcMain } from 'electron'
import { listLocalTasks } from '../../local-tasks/local-task-store'

export function registerLocalTaskHandlers(): void {
  ipcMain.handle('localTasks:list', () => listLocalTasks())
}
