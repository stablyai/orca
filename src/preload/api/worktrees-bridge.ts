import { ipcRenderer } from 'electron'
import type {
  HostLineageSnapshot,
  ListDesktopLineageForHostArgs
} from '../../shared/host-lineage-contract'
import type {
  WorktreeBaseStatusEvent,
  WorktreeRemoteBranchConflictEvent
} from '../../shared/worktree/base-ref-drift-types'
import type { WorktreeHeadIdentity } from '../../shared/worktree/types'
import type { PreloadApi } from '../api-types'

export const worktreesApi = {
  list: (args) => ipcRenderer.invoke('worktrees:list', args),
  listRetiredNames: (args) => ipcRenderer.invoke('worktrees:listRetiredNames', args),

  listDetected: (args) => ipcRenderer.invoke('worktrees:listDetected', args),

  listKnownForExecutionHost: (args) =>
    ipcRenderer.invoke('worktrees:listKnownForExecutionHost', args),

  forgetRemovedForExecutionHost: (args) =>
    ipcRenderer.invoke('worktrees:forgetRemovedForExecutionHost', args),

  cancelListDetected: (args) => ipcRenderer.invoke('worktrees:cancelListDetected', args),

  listAll: () => ipcRenderer.invoke('worktrees:listAll'),

  create: (args) => ipcRenderer.invoke('worktrees:create', args),

  adoptProvisionedRoot: (args) => ipcRenderer.invoke('worktrees:adoptProvisionedRoot', args),

  onCreateProgress: (
    callback: (data: { creationId?: string; phase: 'fetching' | 'creating' }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { creationId?: string; phase: 'fetching' | 'creating' }
    ) => callback(data)
    ipcRenderer.on('createWorktree:progress', listener)
    return () => ipcRenderer.removeListener('createWorktree:progress', listener)
  },

  prefetchCreateBase: (args) => ipcRenderer.invoke('worktrees:prefetchCreateBase', args),

  resolvePrBase: (args) => ipcRenderer.invoke('worktrees:resolvePrBase', args),

  resolveMrBase: (args) => ipcRenderer.invoke('worktrees:resolveMrBase', args),

  remove: (args) => ipcRenderer.invoke('worktrees:remove', args),

  forgetLocal: (args) => ipcRenderer.invoke('worktrees:forgetLocal', args),

  forceDeletePreservedBranch: (args) =>
    ipcRenderer.invoke('worktrees:forceDeletePreservedBranch', args),

  updateMeta: (args) => ipcRenderer.invoke('worktrees:updateMeta', args),

  listLineage: () => ipcRenderer.invoke('worktrees:listLineage'),

  listLineageForHost: (args: ListDesktopLineageForHostArgs): Promise<HostLineageSnapshot> =>
    ipcRenderer.invoke('worktrees:listLineageForHost', args),

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

  onGitStatusMetadataChanged: (callback: (data: { repoId: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { repoId: string }) => callback(data)
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
