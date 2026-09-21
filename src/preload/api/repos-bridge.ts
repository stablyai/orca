import { ipcRenderer } from 'electron'
import type {
  HostRepoCatalogSnapshot,
  ListReposForExecutionHostArgs
} from '../../shared/host-repo-catalog-contract'
import type { BaseRefDefaultResult, BaseRefSearchResult } from '../../shared/repo-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { PreloadApi } from '../api-types'

export const reposApi = {
  list: () => ipcRenderer.invoke('repos:list'),

  listForExecutionHost: (args: ListReposForExecutionHostArgs): Promise<HostRepoCatalogSnapshot> =>
    ipcRenderer.invoke('repos:listForExecutionHost', args),

  add: (args) => ipcRenderer.invoke('repos:add', args),

  addRemote: (args) => ipcRenderer.invoke('repos:addRemote', args),

  create: (args) => ipcRenderer.invoke('repos:create', args),

  isGitAvailable: (): Promise<boolean> => ipcRenderer.invoke('repos:isGitAvailable'),

  getDefaultCreateProjectParent: (): Promise<string> =>
    ipcRenderer.invoke('repos:getDefaultCreateProjectParent'),

  remove: (args) => ipcRenderer.invoke('repos:remove', args),

  removeForHost: (args) => ipcRenderer.invoke('repos:removeForHost', args),

  reorder: (args) => ipcRenderer.invoke('repos:reorder', args),

  reorderForHost: (args) => ipcRenderer.invoke('repos:reorderForHost', args),

  update: (args) => ipcRenderer.invoke('repos:update', args),

  pickFolder: () => ipcRenderer.invoke('repos:pickFolder'),

  pickFolders: () => ipcRenderer.invoke('repos:pickFolders'),

  pickDirectory: () => ipcRenderer.invoke('repos:pickDirectory'),

  clone: (args) => ipcRenderer.invoke('repos:clone', args),

  cloneRemote: (args) => ipcRenderer.invoke('repos:cloneRemote', args),

  createRemote: (args) => ipcRenderer.invoke('repos:createRemote', args),

  cloneAbort: () => ipcRenderer.invoke('repos:cloneAbort'),

  onCloneProgress: (callback: (data: { phase: string; percent: number }) => void): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { phase: string; percent: number }
    ) => callback(data)
    ipcRenderer.on('repos:clone-progress', listener)
    return () => ipcRenderer.removeListener('repos:clone-progress', listener)
  },

  getGitUsername: (args: { repoId: string }): Promise<string> =>
    ipcRenderer.invoke('repos:getGitUsername', args),

  getBaseRefDefault: (args: {
    repoId: string
    hostId?: ExecutionHostId
  }): Promise<BaseRefDefaultResult> => ipcRenderer.invoke('repos:getBaseRefDefault', args),

  searchBaseRefs: (args: {
    repoId: string
    query: string
    limit?: number
    hostId?: ExecutionHostId
  }): Promise<string[]> => ipcRenderer.invoke('repos:searchBaseRefs', args),

  searchBaseRefDetails: (args: {
    repoId: string
    query: string
    limit?: number
    hostId?: ExecutionHostId
  }): Promise<BaseRefSearchResult[]> => ipcRenderer.invoke('repos:searchBaseRefDetails', args),

  onChanged: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('repos:changed', listener)
    return () => ipcRenderer.removeListener('repos:changed', listener)
  }
} satisfies PreloadApi['repos']
