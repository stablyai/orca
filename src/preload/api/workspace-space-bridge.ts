import { ipcRenderer } from 'electron'
import type {
  WorkspaceSpaceAnalysis,
  WorkspaceSpaceScanProgress
} from '../../shared/workspace-space-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { PreloadApi } from '../api-types'

export const workspaceSpaceApi = {
  analyze: () => ipcRenderer.invoke('workspaceSpace:analyze'),
  getCachedAnalysis: () => ipcRenderer.invoke('workspaceSpace:getCachedAnalysis'),
  cancel: () => ipcRenderer.invoke('workspaceSpace:cancel'),
  openWindow: () => ipcRenderer.invoke('workspaceSpace:openWindow'),
  closeWindow: () => ipcRenderer.invoke('workspaceSpace:closeWindow'),
  publishWindowState: (state: unknown) =>
    ipcRenderer.invoke('workspaceSpace:publishWindowState', state),
  requestWindowState: () => ipcRenderer.invoke('workspaceSpace:requestWindowState'),
  revealWorktree: (worktreeId: string, executionHostId?: ExecutionHostId) =>
    ipcRenderer.invoke('workspaceSpace:revealWorktree', worktreeId, executionHostId),
  requestWorktreeRefresh: () => ipcRenderer.invoke('workspaceSpace:requestWorktreeRefresh'),
  publishWindowAnalysis: (analysis: WorkspaceSpaceAnalysis) =>
    ipcRenderer.invoke('workspaceSpace:publishWindowAnalysis', analysis),
  onWindowAnalysis: (callback: (analysis: WorkspaceSpaceAnalysis) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, analysis: WorkspaceSpaceAnalysis): void =>
      callback(analysis)
    ipcRenderer.on('workspaceSpace:windowAnalysis', listener)
    return () => ipcRenderer.removeListener('workspaceSpace:windowAnalysis', listener)
  },
  onWindowStateRequested: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('workspaceSpace:windowStateRequested', listener)
    return () => ipcRenderer.removeListener('workspaceSpace:windowStateRequested', listener)
  },
  onWindowClosed: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('workspaceSpace:windowClosed', listener)
    return () => ipcRenderer.removeListener('workspaceSpace:windowClosed', listener)
  },
  onWindowState: (callback: (state: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: unknown): void => callback(state)
    ipcRenderer.on('workspaceSpace:windowState', listener)
    return () => ipcRenderer.removeListener('workspaceSpace:windowState', listener)
  },
  onRevealWorktree: (callback: (worktreeId: string, executionHostId?: ExecutionHostId) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      worktreeId: string,
      executionHostId?: ExecutionHostId
    ): void => callback(worktreeId, executionHostId)
    ipcRenderer.on('workspaceSpace:revealWorktree', listener)
    return () => ipcRenderer.removeListener('workspaceSpace:revealWorktree', listener)
  },
  onWorktreeRefreshRequested: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('workspaceSpace:worktreeRefreshRequested', listener)
    return () => ipcRenderer.removeListener('workspaceSpace:worktreeRefreshRequested', listener)
  },
  onProgress: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      progress: WorkspaceSpaceScanProgress
    ): void => callback(progress)
    ipcRenderer.on('workspaceSpace:progress', listener)
    return () => ipcRenderer.removeListener('workspaceSpace:progress', listener)
  }
} satisfies PreloadApi['workspaceSpace']
