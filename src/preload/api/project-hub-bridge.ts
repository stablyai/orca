import { ipcRenderer } from 'electron'
import type { ProjectHubApi } from './project-hub-api'
export const projectHubApi: ProjectHubApi = {
  read: (id) => ipcRenderer.invoke('projectHub:read',id),
  save: (args) => ipcRenderer.invoke('projectHub:save',args)
}
