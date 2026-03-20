import { contextBridge, ipcRenderer, webFrame } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  repos: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke('repos:list'),

    add: (args: { path: string }): Promise<unknown> => ipcRenderer.invoke('repos:add', args),

    remove: (args: { repoId: string }): Promise<void> => ipcRenderer.invoke('repos:remove', args),

    update: (args: { repoId: string; updates: Record<string, unknown> }): Promise<unknown> =>
      ipcRenderer.invoke('repos:update', args),

    pickFolder: (): Promise<string | null> => ipcRenderer.invoke('repos:pickFolder'),

    getGitUsername: (args: { repoId: string }): Promise<string> =>
      ipcRenderer.invoke('repos:getGitUsername', args),

    getBaseRefDefault: (args: { repoId: string }): Promise<string> =>
      ipcRenderer.invoke('repos:getBaseRefDefault', args),

    searchBaseRefs: (args: { repoId: string; query: string; limit?: number }): Promise<string[]> =>
      ipcRenderer.invoke('repos:searchBaseRefs', args),

    onChanged: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('repos:changed', listener)
      return () => ipcRenderer.removeListener('repos:changed', listener)
    }
  },

  worktrees: {
    list: (args: { repoId: string }): Promise<unknown[]> =>
      ipcRenderer.invoke('worktrees:list', args),

    listAll: (): Promise<unknown[]> => ipcRenderer.invoke('worktrees:listAll'),

    create: (args: { repoId: string; name: string; baseBranch?: string }): Promise<unknown> =>
      ipcRenderer.invoke('worktrees:create', args),

    remove: (args: { worktreeId: string; force?: boolean }): Promise<void> =>
      ipcRenderer.invoke('worktrees:remove', args),

    updateMeta: (args: {
      worktreeId: string
      updates: Record<string, unknown>
    }): Promise<unknown> => ipcRenderer.invoke('worktrees:updateMeta', args),

    onChanged: (callback: (data: { repoId: string }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { repoId: string }) =>
        callback(data)
      ipcRenderer.on('worktrees:changed', listener)
      return () => ipcRenderer.removeListener('worktrees:changed', listener)
    }
  },

  pty: {
    spawn: (opts: { cols: number; rows: number; cwd?: string }): Promise<{ id: string }> =>
      ipcRenderer.invoke('pty:spawn', opts),

    write: (id: string, data: string): void => {
      ipcRenderer.send('pty:write', { id, data })
    },

    resize: (id: string, cols: number, rows: number): void => {
      ipcRenderer.invoke('pty:resize', { id, cols, rows })
    },

    kill: (id: string): Promise<void> => ipcRenderer.invoke('pty:kill', { id }),

    onData: (callback: (data: { id: string; data: string }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { id: string; data: string }) =>
        callback(data)
      ipcRenderer.on('pty:data', listener)
      return () => ipcRenderer.removeListener('pty:data', listener)
    },

    onExit: (callback: (data: { id: string; code: number }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { id: string; code: number }) =>
        callback(data)
      ipcRenderer.on('pty:exit', listener)
      return () => ipcRenderer.removeListener('pty:exit', listener)
    }
  },

  gh: {
    prForBranch: (args: { repoPath: string; branch: string }): Promise<unknown> =>
      ipcRenderer.invoke('gh:prForBranch', args),

    issue: (args: { repoPath: string; number: number }): Promise<unknown> =>
      ipcRenderer.invoke('gh:issue', args),

    listIssues: (args: { repoPath: string; limit?: number }): Promise<unknown[]> =>
      ipcRenderer.invoke('gh:listIssues', args)
  },

  settings: {
    get: (): Promise<unknown> => ipcRenderer.invoke('settings:get'),

    set: (args: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('settings:set', args),

    listFonts: (): Promise<string[]> => ipcRenderer.invoke('settings:listFonts')
  },

  shell: {
    openPath: (path: string): Promise<void> => ipcRenderer.invoke('shell:openPath', path),

    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url)
  },

  hooks: {
    check: (args: { repoId: string }): Promise<{ hasHooks: boolean; hooks: unknown }> =>
      ipcRenderer.invoke('hooks:check', args)
  },

  cache: {
    getGitHub: () => ipcRenderer.invoke('cache:getGitHub'),
    setGitHub: (args: { cache: unknown }) => ipcRenderer.invoke('cache:setGitHub', args)
  },

  session: {
    get: (): Promise<unknown> => ipcRenderer.invoke('session:get'),
    set: (args: unknown): Promise<void> => ipcRenderer.invoke('session:set', args)
  },

  ui: {
    get: (): Promise<unknown> => ipcRenderer.invoke('ui:get'),
    set: (args: Record<string, unknown>): Promise<void> => ipcRenderer.invoke('ui:set', args),
    onOpenSettings: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:openSettings', listener)
      return () => ipcRenderer.removeListener('ui:openSettings', listener)
    },
    onTerminalZoom: (callback: (direction: 'in' | 'out' | 'reset') => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, direction: 'in' | 'out' | 'reset') =>
        callback(direction)
      ipcRenderer.on('terminal:zoom', listener)
      return () => ipcRenderer.removeListener('terminal:zoom', listener)
    },
    getZoomLevel: (): number => webFrame.getZoomLevel(),
    setZoomLevel: (level: number): void => webFrame.setZoomLevel(level)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
