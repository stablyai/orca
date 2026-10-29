import { ipcRenderer } from 'electron'
import type {
  WorktreeBaseStatusEvent,
  WorktreeRemoteBranchConflictEvent
} from '../../shared/worktree/base-ref-drift-types'
import type { CreateWorktreeProgressEvent } from '../../shared/worktree/create-types'
import type {
  GitStatusMetadataChangedEvent,
  WorktreeHeadIdentity
} from '../../shared/worktree/types'
import type { PreloadApi } from '../api-types'

export const worktreesApi = {
  listRetiredNames: (args) => ipcRenderer.invoke('worktrees:listRetiredNames', args),

  listDetected: (args) => ipcRenderer.invoke('worktrees:listDetected', args),

  listKnownForExecutionHost: (args) =>
    ipcRenderer.invoke('worktrees:listKnownForExecutionHost', args),

  forgetRemovedForExecutionHost: (args) =>
    ipcRenderer.invoke('worktrees:forgetRemovedForExecutionHost', args),

  cancelListDetected: (args) => ipcRenderer.invoke('worktrees:cancelListDetected', args),

  create: (args) => ipcRenderer.invoke('worktrees:create', args),

  adoptProvisionedRoot: (args) => ipcRenderer.invoke('worktrees:adoptProvisionedRoot', args),

  onCreateProgress: (callback: (data: CreateWorktreeProgressEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: CreateWorktreeProgressEvent) =>
      callback(data)
    ipcRenderer.on('createWorktree:progress', listener)
    return () => ipcRenderer.removeListener('createWorktree:progress', listener)
  },

  prefetchCreateBase: (args) => ipcRenderer.invoke('worktrees:prefetchCreateBase', args),

  resolvePrBase: (args) => ipcRenderer.invoke('worktrees:resolvePrBase', args),

  resolveMrBase: (args) => ipcRenderer.invoke('worktrees:resolveMrBase', args),

  previewNestedRemoval: (args) => ipcRenderer.invoke('worktrees:previewNestedRemoval', args),

  sleep: (request) => ipcRenderer.invoke('worktrees:sleep', request),
  sleepReopened: (worktreeId) => ipcRenderer.invoke('worktrees:sleepReopened', worktreeId),
  resumeSleptPane: (pane) => ipcRenderer.invoke('worktrees:resumeSleptPane', pane),
  retireStrandedSleepRecord: (args) =>
    ipcRenderer.invoke('worktrees:retireStrandedSleepRecord', args),

  remove: (args) => ipcRenderer.invoke('worktrees:remove', args),

  forgetLocal: (args) => ipcRenderer.invoke('worktrees:forgetLocal', args),

  forceDeletePreservedBranch: (args) =>
    ipcRenderer.invoke('worktrees:forceDeletePreservedBranch', args),

  updateMeta: (args) => ipcRenderer.invoke('worktrees:updateMeta', args),

  listLineage: () => ipcRenderer.invoke('worktrees:listLineage'),

  updateLineage: (args) => ipcRenderer.invoke('worktrees:updateLineage', args),

  persistSortOrder: (args) => ipcRenderer.invoke('worktrees:persistSortOrder', args),

  getBranchRenameFailureOutput: (args) =>
    ipcRenderer.invoke('worktrees:getBranchRenameFailureOutput', args),

  onChanged: (
    callback: (data: {
      repoId: string
      renamed?: { oldWorktreeId: string; newWorktreeId: string }
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { repoId: string; renamed?: { oldWorktreeId: string; newWorktreeId: string } }
    ) => callback(data)
    ipcRenderer.on('worktrees:changed', listener)
    return () => ipcRenderer.removeListener('worktrees:changed', listener)
  },

  onGitStatusMetadataChanged: (
    callback: (data: GitStatusMetadataChangedEvent) => void
  ): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: GitStatusMetadataChangedEvent) =>
      callback(data)
    ipcRenderer.on('worktrees:gitStatusMetadataChanged', listener)
    return () => ipcRenderer.removeListener('worktrees:gitStatusMetadataChanged', listener)
  },

  onHeadIdentitiesChanged: (
    callback: (data: { repoId: string; identities: WorktreeHeadIdentity[] }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { repoId: string; identities: WorktreeHeadIdentity[] }
    ) => callback(data)
    ipcRenderer.on('worktrees:headIdentitiesChanged', listener)
    return () => ipcRenderer.removeListener('worktrees:headIdentitiesChanged', listener)
  },

  onBaseStatus: (callback: (data: WorktreeBaseStatusEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: WorktreeBaseStatusEvent) =>
      callback(data)
    ipcRenderer.on('worktree:baseStatus', listener)
    return () => ipcRenderer.removeListener('worktree:baseStatus', listener)
  },

  onRemoteBranchConflict: (
    callback: (data: WorktreeRemoteBranchConflictEvent) => void
  ): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: WorktreeRemoteBranchConflictEvent) =>
      callback(data)
    ipcRenderer.on('worktree:remoteBranchConflict', listener)
    return () => ipcRenderer.removeListener('worktree:remoteBranchConflict', listener)
  }
} satisfies PreloadApi['worktrees']
