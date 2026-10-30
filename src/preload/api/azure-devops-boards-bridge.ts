import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const azureDevOpsBoardsApi = {
  isAuthenticated: (args) => ipcRenderer.invoke('azureDevOpsBoards:isAuthenticated', args),
  listTeams: (args) => ipcRenderer.invoke('azureDevOpsBoards:listTeams', args),
  getConfiguration: (args) => ipcRenderer.invoke('azureDevOpsBoards:getConfiguration', args),
  loadBacklog: (args) => ipcRenderer.invoke('azureDevOpsBoards:loadBacklog', args),
  loadBoard: (args) => ipcRenderer.invoke('azureDevOpsBoards:loadBoard', args),
  getWorkItem: (args) => ipcRenderer.invoke('azureDevOpsBoards:getWorkItem', args)
} satisfies PreloadApi['azureDevOpsBoards']
