import { ipcRenderer } from 'electron'
import type { WorkspaceSpaceScanProgress } from '../../shared/workspace-space-types'
import type { PreloadApi } from '../api-types'

export const workspaceSpaceApi = {
  analyze: () => ipcRenderer.invoke('workspaceSpace:analyze'),
  getCachedAnalysis: () => ipcRenderer.invoke('workspaceSpace:getCachedAnalysis'),
  cancel: () => ipcRenderer.invoke('workspaceSpace:cancel'),
  onProgress: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      progress: WorkspaceSpaceScanProgress
    ): void => callback(progress)
    ipcRenderer.on('workspaceSpace:progress', listener)
    return () => ipcRenderer.removeListener('workspaceSpace:progress', listener)
  }
} satisfies PreloadApi['workspaceSpace']
