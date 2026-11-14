import { ipcRenderer } from 'electron'
import type {
  WorkspacePopoutEntrySummary,
  WorkspacePopoutOpenResult,
  WorkspacePopoutStateChanged,
  WorkspacePopoutTarget
} from '../../shared/workspace-popout/workspace-popout-contract'

export type WorkspacePopoutApi = {
  open: (target: WorkspacePopoutTarget) => Promise<WorkspacePopoutOpenResult>
  publishTarget: (target: WorkspacePopoutTarget) => Promise<void>
  dock: (worktreeId: string) => Promise<void>
  focus: (worktreeId: string) => Promise<boolean>
  list: () => Promise<WorkspacePopoutEntrySummary[]>
  getTarget: () => Promise<WorkspacePopoutTarget | null>
  onStateChanged: (callback: (change: WorkspacePopoutStateChanged) => void) => () => void
  onTarget: (callback: (target: WorkspacePopoutTarget) => void) => () => void
  onResumed: (callback: () => void) => () => void
}

export const workspacePopoutApi: WorkspacePopoutApi = {
  open: (target: WorkspacePopoutTarget): Promise<WorkspacePopoutOpenResult> =>
    ipcRenderer.invoke('workspacePopout:open', target),

  publishTarget: (target: WorkspacePopoutTarget): Promise<void> =>
    ipcRenderer.invoke('workspacePopout:publishTarget', target),

  dock: (worktreeId: string): Promise<void> =>
    ipcRenderer.invoke('workspacePopout:dock', { worktreeId }),

  focus: (worktreeId: string): Promise<boolean> =>
    ipcRenderer.invoke('workspacePopout:focus', { worktreeId }),

  list: (): Promise<WorkspacePopoutEntrySummary[]> => ipcRenderer.invoke('workspacePopout:list'),

  getTarget: (): Promise<WorkspacePopoutTarget | null> =>
    ipcRenderer.invoke('workspacePopout:getTarget'),

  onStateChanged: (callback: (change: WorkspacePopoutStateChanged) => void): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      change: WorkspacePopoutStateChanged
    ): void => callback(change)
    ipcRenderer.on('workspacePopout:stateChanged', listener)
    return () => ipcRenderer.removeListener('workspacePopout:stateChanged', listener)
  },

  onTarget: (callback: (target: WorkspacePopoutTarget) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, target: WorkspacePopoutTarget): void =>
      callback(target)
    ipcRenderer.on('workspacePopout:target', listener)
    return () => ipcRenderer.removeListener('workspacePopout:target', listener)
  },

  onResumed: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('workspacePopout:resumed', listener)
    return () => ipcRenderer.removeListener('workspacePopout:resumed', listener)
  }
}
