import { ipcRenderer } from 'electron'
import type { LocalTasksApi } from './local-tasks-api'

export const localTasksApi: LocalTasksApi = {
  list: () => ipcRenderer.invoke('localTasks:list')
}
