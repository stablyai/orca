/* eslint-disable max-lines -- Why: the preload bridge is the audited contract between
renderer and Electron. Keeping the IPC surface co-located in one file makes security
review and type drift checks easier than scattering these bindings across modules. */
import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { CliInstallStatus } from '../shared/cli-install-types'
import type { RuntimeStatus, RuntimeSyncWindowGraph } from '../shared/runtime-types'

type NativeFileDropTarget = 'editor' | 'terminal'

function getNativeFileDropTarget(event: DragEvent): NativeFileDropTarget | null {
  const path = event.composedPath()
  for (const entry of path) {
    if (!(entry instanceof HTMLElement)) {
      continue
    }
    const target = entry.dataset.nativeFileDropTarget
    if (target === 'editor' || target === 'terminal') {
      return target
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// File drag-and-drop: handled here in the preload because webUtils (which
// resolves File objects to filesystem paths) is only available in Electron's
// preload/main worlds, not the renderer's isolated main world.
// ---------------------------------------------------------------------------
document.addEventListener(
  'dragover',
  (e) => {
    // Let in-app drags (e.g. file explorer drag-to-move) through to React handlers
    // so they can set their own dropEffect. Only override for native OS file drops.
    if (e.dataTransfer?.types.includes('text/x-orca-file-path')) {
      return
    }
    e.preventDefault()
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy'
    }
  },
  true
)

document.addEventListener(
  'drop',
  (e) => {
    // Let in-app drags (e.g. file explorer → terminal) through to React handlers
    if (e.dataTransfer?.types.includes('text/x-orca-file-path')) {
      return
    }

    e.preventDefault()
    e.stopPropagation()
    const files = e.dataTransfer?.files
    if (!files || files.length === 0) {
      return
    }
    const target = getNativeFileDropTarget(e)

    const paths: string[] = []
    for (let i = 0; i < files.length; i++) {
      // webUtils.getPathForFile is the Electron 28+ replacement for File.path
      const filePath = webUtils.getPathForFile(files[i])
      if (filePath) {
        paths.push(filePath)
      }
    }

    if (paths.length > 0) {
      // Why: native OS file drops must be classified before the event crosses
      // into the isolated renderer; otherwise every drop looks identical and we
      // cannot distinguish "open this in Orca's editor" from "send this path to
      // the active coding CLI". Falls back to 'editor' so drops on surfaces
      // without an explicit marker (sidebar, editor body, etc.) preserve the
      // prior open-in-editor behavior instead of being silently discarded.
      ipcRenderer.send('terminal:file-dropped-from-preload', {
        paths,
        target: target ?? 'editor'
      })
    }
  },
  true
)

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

    create: (args: {
      repoId: string
      name: string
      baseBranch?: string
      setupDecision?: 'inherit' | 'run' | 'skip'
    }): Promise<unknown> => ipcRenderer.invoke('worktrees:create', args),

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
    spawn: (opts: {
      cols: number
      rows: number
      cwd?: string
      env?: Record<string, string>
    }): Promise<{ id: string }> => ipcRenderer.invoke('pty:spawn', opts),

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
      ipcRenderer.invoke('gh:listIssues', args),

    prChecks: (args: {
      repoPath: string
      prNumber: number
      headSha?: string
      noCache?: boolean
    }): Promise<unknown[]> => ipcRenderer.invoke('gh:prChecks', args),

    updatePRTitle: (args: {
      repoPath: string
      prNumber: number
      title: string
    }): Promise<boolean> => ipcRenderer.invoke('gh:updatePRTitle', args),

    mergePR: (args: {
      repoPath: string
      prNumber: number
      method?: 'merge' | 'squash' | 'rebase'
    }): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('gh:mergePR', args)
  },

  settings: {
    get: (): Promise<unknown> => ipcRenderer.invoke('settings:get'),

    set: (args: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('settings:set', args),

    listFonts: (): Promise<string[]> => ipcRenderer.invoke('settings:listFonts')
  },

  cli: {
    getInstallStatus: (): Promise<CliInstallStatus> => ipcRenderer.invoke('cli:getInstallStatus'),
    install: (): Promise<CliInstallStatus> => ipcRenderer.invoke('cli:install'),
    remove: (): Promise<CliInstallStatus> => ipcRenderer.invoke('cli:remove')
  },

  preflight: {
    check: (): Promise<{
      git: { installed: boolean }
      gh: { installed: boolean; authenticated: boolean }
    }> => ipcRenderer.invoke('preflight:check')
  },

  shell: {
    openPath: (path: string): Promise<void> => ipcRenderer.invoke('shell:openPath', path),

    openUrl: (url: string): Promise<void> => ipcRenderer.invoke('shell:openUrl', url),

    openFilePath: (path: string): Promise<void> => ipcRenderer.invoke('shell:openFilePath', path),

    openFileUri: (uri: string): Promise<void> => ipcRenderer.invoke('shell:openFileUri', uri),

    pathExists: (path: string): Promise<boolean> => ipcRenderer.invoke('shell:pathExists', path),

    pickImage: (): Promise<string | null> => ipcRenderer.invoke('shell:pickImage'),

    copyFile: (args: { srcPath: string; destPath: string }): Promise<void> =>
      ipcRenderer.invoke('shell:copyFile', args)
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
    set: (args: unknown): Promise<void> => ipcRenderer.invoke('session:set', args),
    /** Synchronous session save for beforeunload — blocks until flushed to disk. */
    setSync: (args: unknown): void => {
      ipcRenderer.sendSync('session:set-sync', args)
    }
  },

  updater: {
    getStatus: (): Promise<unknown> => ipcRenderer.invoke('updater:getStatus'),
    getVersion: (): Promise<string> => ipcRenderer.invoke('updater:getVersion'),
    check: (): Promise<void> => ipcRenderer.invoke('updater:check'),
    download: (): Promise<void> => ipcRenderer.invoke('updater:download'),
    quitAndInstall: (): Promise<void> => {
      // Dispatch beforeunload to trigger terminal buffer capture before the
      // update process bypasses the normal window close sequence (quitAndInstall
      // removes close listeners, preventing beforeunload from firing naturally).
      window.dispatchEvent(new Event('beforeunload'))
      return ipcRenderer.invoke('updater:quitAndInstall')
    },
    onStatus: (callback: (status: unknown) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status)
      ipcRenderer.on('updater:status', listener)
      return () => ipcRenderer.removeListener('updater:status', listener)
    }
  },

  fs: {
    readDir: (args: {
      dirPath: string
    }): Promise<{ name: string; isDirectory: boolean; isSymlink: boolean }[]> =>
      ipcRenderer.invoke('fs:readDir', args),
    readFile: (args: {
      filePath: string
    }): Promise<{ content: string; isBinary: boolean; isImage?: boolean; mimeType?: string }> =>
      ipcRenderer.invoke('fs:readFile', args),
    writeFile: (args: { filePath: string; content: string }): Promise<void> =>
      ipcRenderer.invoke('fs:writeFile', args),
    createFile: (args: { filePath: string }): Promise<void> =>
      ipcRenderer.invoke('fs:createFile', args),
    createDir: (args: { dirPath: string }): Promise<void> =>
      ipcRenderer.invoke('fs:createDir', args),
    rename: (args: { oldPath: string; newPath: string }): Promise<void> =>
      ipcRenderer.invoke('fs:rename', args),
    deletePath: (args: { targetPath: string }): Promise<void> =>
      ipcRenderer.invoke('fs:deletePath', args),
    authorizeExternalPath: (args: { targetPath: string }): Promise<void> =>
      ipcRenderer.invoke('fs:authorizeExternalPath', args),
    stat: (args: {
      filePath: string
    }): Promise<{ size: number; isDirectory: boolean; mtime: number }> =>
      ipcRenderer.invoke('fs:stat', args),
    listFiles: (args: { rootPath: string }): Promise<string[]> =>
      ipcRenderer.invoke('fs:listFiles', args),
    search: (args: {
      query: string
      rootPath: string
      caseSensitive?: boolean
      wholeWord?: boolean
      useRegex?: boolean
      includePattern?: string
      excludePattern?: string
      maxResults?: number
    }): Promise<{
      files: {
        filePath: string
        relativePath: string
        matches: { line: number; column: number; matchLength: number; lineContent: string }[]
      }[]
      totalMatches: number
      truncated: boolean
    }> => ipcRenderer.invoke('fs:search', args)
  },

  git: {
    status: (args: { worktreePath: string }): Promise<unknown> =>
      ipcRenderer.invoke('git:status', args),
    conflictOperation: (args: { worktreePath: string }): Promise<unknown> =>
      ipcRenderer.invoke('git:conflictOperation', args),
    diff: (args: { worktreePath: string; filePath: string; staged: boolean }): Promise<unknown> =>
      ipcRenderer.invoke('git:diff', args),
    branchCompare: (args: { worktreePath: string; baseRef: string }): Promise<unknown> =>
      ipcRenderer.invoke('git:branchCompare', args),
    branchDiff: (args: {
      worktreePath: string
      compare: { baseRef: string; baseOid: string; headOid: string; mergeBase: string }
      filePath: string
      oldPath?: string
    }): Promise<unknown> => ipcRenderer.invoke('git:branchDiff', args),
    stage: (args: { worktreePath: string; filePath: string }): Promise<void> =>
      ipcRenderer.invoke('git:stage', args),
    unstage: (args: { worktreePath: string; filePath: string }): Promise<void> =>
      ipcRenderer.invoke('git:unstage', args),
    discard: (args: { worktreePath: string; filePath: string }): Promise<void> =>
      ipcRenderer.invoke('git:discard', args),
    remoteFileUrl: (args: {
      worktreePath: string
      relativePath: string
      line: number
    }): Promise<string | null> => ipcRenderer.invoke('git:remoteFileUrl', args)
  },

  ui: {
    get: (): Promise<unknown> => ipcRenderer.invoke('ui:get'),
    set: (args: Record<string, unknown>): Promise<void> => ipcRenderer.invoke('ui:set', args),
    onOpenSettings: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:openSettings', listener)
      return () => ipcRenderer.removeListener('ui:openSettings', listener)
    },
    onActivateWorktree: (
      callback: (data: {
        repoId: string
        worktreeId: string
        setup?: { runnerScriptPath: string; envVars: Record<string, string> }
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          repoId: string
          worktreeId: string
          setup?: { runnerScriptPath: string; envVars: Record<string, string> }
        }
      ) => callback(data)
      ipcRenderer.on('ui:activateWorktree', listener)
      return () => ipcRenderer.removeListener('ui:activateWorktree', listener)
    },
    onTerminalZoom: (callback: (direction: 'in' | 'out' | 'reset') => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, direction: 'in' | 'out' | 'reset') =>
        callback(direction)
      ipcRenderer.on('terminal:zoom', listener)
      return () => ipcRenderer.removeListener('terminal:zoom', listener)
    },
    readClipboardText: (): Promise<string> => ipcRenderer.invoke('clipboard:readText'),
    writeClipboardText: (text: string): Promise<void> =>
      ipcRenderer.invoke('clipboard:writeText', text),
    onFileDrop: (
      callback: (data: { path: string; target: 'editor' | 'terminal' }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { path: string; target: 'editor' | 'terminal' }
      ) => callback(data)
      ipcRenderer.on('terminal:file-drop', listener)
      return () => ipcRenderer.removeListener('terminal:file-drop', listener)
    },
    getZoomLevel: (): number => webFrame.getZoomLevel(),
    setZoomLevel: (level: number): void => webFrame.setZoomLevel(level)
  },

  runtime: {
    syncWindowGraph: (graph: RuntimeSyncWindowGraph): Promise<RuntimeStatus> =>
      ipcRenderer.invoke('runtime:syncWindowGraph', graph),
    getStatus: (): Promise<RuntimeStatus> => ipcRenderer.invoke('runtime:getStatus')
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
