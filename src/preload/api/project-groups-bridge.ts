import { ipcRenderer } from 'electron'
import type { NestedRepoScanResult } from '../../shared/project-group-types'
import type { PreloadApi } from '../api-types'

export const projectGroupsApi = {
  list: () => ipcRenderer.invoke('projectGroups:list'),
  create: (args) => ipcRenderer.invoke('projectGroups:create', args),
  update: (args) => ipcRenderer.invoke('projectGroups:update', args),
  delete: (args) => ipcRenderer.invoke('projectGroups:delete', args),
  moveProject: (args) => ipcRenderer.invoke('projectGroups:moveProject', args),
  scanNested: (args) => ipcRenderer.invoke('projectGroups:scanNested', args),
  cancelNestedScan: (args) => ipcRenderer.invoke('projectGroups:cancelNestedScan', args),
  onNestedScanProgress: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { scanId: string; scan: NestedRepoScanResult }
    ) => callback(data)
    ipcRenderer.on('projectGroups:scanNestedProgress', listener)
    return () => ipcRenderer.removeListener('projectGroups:scanNestedProgress', listener)
  },
  importNested: (args) => ipcRenderer.invoke('projectGroups:importNested', args)
} satisfies PreloadApi['projectGroups']
