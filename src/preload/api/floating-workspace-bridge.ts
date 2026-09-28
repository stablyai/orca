import { ipcRenderer } from 'electron'
import type { FloatingWorkspaceApi } from './floating-workspace-api'
import type { WorkspaceDisplayInfo } from '../../shared/floating-workspace-display'

export const floatingWorkspaceApi: FloatingWorkspaceApi = {
  getDisplays: (): Promise<WorkspaceDisplayInfo[]> =>
    ipcRenderer.invoke('floatingWorkspace:getDisplays'),
  getCurrentDisplayId: (): Promise<number | null> =>
    ipcRenderer.invoke('floatingWorkspace:getCurrentDisplayId'),
  moveToDisplay: (displayId: number): Promise<boolean> =>
    ipcRenderer.invoke('floatingWorkspace:moveToDisplay', displayId),
  moveToNextDisplay: (): Promise<boolean> =>
    ipcRenderer.invoke('floatingWorkspace:moveToNextDisplay'),
  identifyDisplays: (): Promise<boolean> =>
    ipcRenderer.invoke('floatingWorkspace:identifyDisplays'),
  onDisplaysChanged: (callback: (displays: WorkspaceDisplayInfo[]) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, displays: WorkspaceDisplayInfo[]) =>
      callback(displays)
    ipcRenderer.on('floatingWorkspace:displaysChanged', listener)
    return () => ipcRenderer.removeListener('floatingWorkspace:displaysChanged', listener)
  },
  minimize: (): Promise<boolean> => ipcRenderer.invoke('floatingWorkspace:minimize'),
  isMinimized: (): Promise<boolean> => ipcRenderer.invoke('floatingWorkspace:isMinimized')
}
