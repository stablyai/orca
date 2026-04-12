/* eslint-disable max-lines -- Why: the preload bridge is the audited contract between
renderer and Electron. Keeping the IPC surface co-located in one file makes security
review and type drift checks easier than scattering these bindings across modules. */
import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { CliInstallStatus } from '../shared/cli-install-types'
import type {
  FsChangedPayload,
  NotificationDispatchResult,
  OpenCodeStatusEvent
} from '../shared/types'
import type { RuntimeStatus, RuntimeSyncWindowGraph } from '../shared/runtime-types'
import type { RateLimitState } from '../shared/rate-limit-types'
import {
  ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT,
  type EditorSaveDirtyFilesDetail
} from '../shared/editor-save-events'
import {
  ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT,
  ORCA_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT
} from '../shared/updater-renderer-events'

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

    add: (args: { path: string; kind?: 'git' | 'folder' }): Promise<unknown> =>
      ipcRenderer.invoke('repos:add', args),

    remove: (args: { repoId: string }): Promise<void> => ipcRenderer.invoke('repos:remove', args),

    update: (args: { repoId: string; updates: Record<string, unknown> }): Promise<unknown> =>
      ipcRenderer.invoke('repos:update', args),

    pickFolder: (): Promise<string | null> => ipcRenderer.invoke('repos:pickFolder'),

    pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('repos:pickDirectory'),

    clone: (args: { url: string; destination: string }): Promise<unknown> =>
      ipcRenderer.invoke('repos:clone', args),

    cloneAbort: (): Promise<void> => ipcRenderer.invoke('repos:cloneAbort'),

    onCloneProgress: (
      callback: (data: { phase: string; percent: number }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { phase: string; percent: number }
      ) => callback(data)
      ipcRenderer.on('repos:clone-progress', listener)
      return () => ipcRenderer.removeListener('repos:clone-progress', listener)
    },

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

    persistSortOrder: (args: { orderedIds: string[] }): Promise<void> =>
      ipcRenderer.invoke('worktrees:persistSortOrder', args),

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

    /** Check if a PTY's shell has child processes (e.g. a running command).
     *  Returns false for an idle shell prompt. */
    hasChildProcesses: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('pty:hasChildProcesses', { id }),

    /** Return the PTY foreground process basename when available (e.g. "codex"). */
    getForegroundProcess: (id: string): Promise<string | null> =>
      ipcRenderer.invoke('pty:getForegroundProcess', { id }),

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
    },

    onOpenCodeStatus: (callback: (event: OpenCodeStatusEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: OpenCodeStatusEvent) =>
        callback(data)
      ipcRenderer.on('pty:opencode-status', listener)
      return () => ipcRenderer.removeListener('pty:opencode-status', listener)
    }
  },

  gh: {
    viewer: (): Promise<unknown> => ipcRenderer.invoke('gh:viewer'),

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

    prComments: (args: {
      repoPath: string
      prNumber: number
      noCache?: boolean
    }): Promise<unknown[]> => ipcRenderer.invoke('gh:prComments', args),

    resolveReviewThread: (args: {
      repoPath: string
      threadId: string
      resolve: boolean
    }): Promise<boolean> => ipcRenderer.invoke('gh:resolveReviewThread', args),

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
      ipcRenderer.invoke('gh:mergePR', args),

    checkOrcaStarred: (): Promise<boolean | null> => ipcRenderer.invoke('gh:checkOrcaStarred'),
    starOrca: (): Promise<boolean> => ipcRenderer.invoke('gh:starOrca')
  },

  settings: {
    get: (): Promise<unknown> => ipcRenderer.invoke('settings:get'),

    set: (args: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('settings:set', args),

    listFonts: (): Promise<string[]> => ipcRenderer.invoke('settings:listFonts')
  },

  codexAccounts: {
    list: (): Promise<unknown> => ipcRenderer.invoke('codexAccounts:list'),
    add: (): Promise<unknown> => ipcRenderer.invoke('codexAccounts:add'),
    reauthenticate: (args: { accountId: string }): Promise<unknown> =>
      ipcRenderer.invoke('codexAccounts:reauthenticate', args),
    remove: (args: { accountId: string }): Promise<unknown> =>
      ipcRenderer.invoke('codexAccounts:remove', args),
    select: (args: { accountId: string | null }): Promise<unknown> =>
      ipcRenderer.invoke('codexAccounts:select', args)
  },

  cli: {
    getInstallStatus: (): Promise<CliInstallStatus> => ipcRenderer.invoke('cli:getInstallStatus'),
    install: (): Promise<CliInstallStatus> => ipcRenderer.invoke('cli:install'),
    remove: (): Promise<CliInstallStatus> => ipcRenderer.invoke('cli:remove')
  },

  preflight: {
    check: (args?: {
      force?: boolean
    }): Promise<{
      git: { installed: boolean }
      gh: { installed: boolean; authenticated: boolean }
    }> => ipcRenderer.invoke('preflight:check', args)
  },

  notifications: {
    dispatch: (args: Record<string, unknown>): Promise<NotificationDispatchResult> =>
      ipcRenderer.invoke('notifications:dispatch', args),
    openSystemSettings: (): Promise<void> => ipcRenderer.invoke('notifications:openSystemSettings')
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

  browser: {
    registerGuest: (args: { browserTabId: string; webContentsId: number }): Promise<void> =>
      ipcRenderer.invoke('browser:registerGuest', args),

    unregisterGuest: (args: { browserTabId: string }): Promise<void> =>
      ipcRenderer.invoke('browser:unregisterGuest', args),

    openDevTools: (args: { browserTabId: string }): Promise<boolean> =>
      ipcRenderer.invoke('browser:openDevTools', args),

    onGuestLoadFailed: (
      callback: (args: {
        browserTabId: string
        loadError: { code: number; description: string; validatedUrl: string }
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          browserTabId: string
          loadError: { code: number; description: string; validatedUrl: string }
        }
      ) => callback(data)
      ipcRenderer.on('browser:guest-load-failed', listener)
      return () => ipcRenderer.removeListener('browser:guest-load-failed', listener)
    },

    setGrabMode: (args: {
      browserTabId: string
      enabled: boolean
    }): Promise<{ ok: true } | { ok: false; reason: string }> =>
      ipcRenderer.invoke('browser:setGrabMode', args),

    awaitGrabSelection: (args: { browserTabId: string; opId: string }): Promise<unknown> =>
      ipcRenderer.invoke('browser:awaitGrabSelection', args),

    cancelGrab: (args: { browserTabId: string }): Promise<boolean> =>
      ipcRenderer.invoke('browser:cancelGrab', args),

    captureSelectionScreenshot: (args: {
      browserTabId: string
      rect: { x: number; y: number; width: number; height: number }
    }): Promise<{ ok: true; screenshot: unknown } | { ok: false; reason: string }> =>
      ipcRenderer.invoke('browser:captureSelectionScreenshot', args),

    extractHoverPayload: (args: {
      browserTabId: string
    }): Promise<{ ok: true; payload: unknown } | { ok: false; reason: string }> =>
      ipcRenderer.invoke('browser:extractHoverPayload', args),

    onGrabModeToggle: (callback: (browserTabId: string) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, browserTabId: string) =>
        callback(browserTabId)
      ipcRenderer.on('browser:grabModeToggle', listener)
      return () => ipcRenderer.removeListener('browser:grabModeToggle', listener)
    },

    onGrabActionShortcut: (
      callback: (args: { browserTabId: string; key: 'c' | 's' }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { browserTabId: string; key: 'c' | 's' }
      ) => callback(data)
      ipcRenderer.on('browser:grabActionShortcut', listener)
      return () => ipcRenderer.removeListener('browser:grabActionShortcut', listener)
    }
  },

  hooks: {
    check: (args: {
      repoId: string
    }): Promise<{ hasHooks: boolean; hooks: unknown; mayNeedUpdate: boolean }> =>
      ipcRenderer.invoke('hooks:check', args),

    readIssueCommand: (args: {
      repoId: string
    }): Promise<{
      localContent: string | null
      sharedContent: string | null
      effectiveContent: string | null
      localFilePath: string
      source: 'local' | 'shared' | 'none'
    }> => ipcRenderer.invoke('hooks:readIssueCommand', args),

    writeIssueCommand: (args: { repoId: string; content: string }): Promise<void> =>
      ipcRenderer.invoke('hooks:writeIssueCommand', args)
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
    quitAndInstall: async (): Promise<void> => {
      // Why: quitAndInstall closes the BrowserWindow directly from the main
      // process. Renderer beforeunload guards treat that like a normal window
      // close unless we mark the updater path explicitly, and #300 introduced
      // longer-lived editor dirty/autosave state that can otherwise veto the
      // restart even after the update payload has been downloaded.
      window.dispatchEvent(new Event(ORCA_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT))

      // Why: we wrap the save attempt in try/catch so that a save failure
      // (e.g., unsupported dirty files or a write error) never silently
      // prevents the update from installing. The user already clicked
      // "install update" — proceeding with the restart is better than
      // leaving them stuck with no feedback.
      try {
        await new Promise<void>((resolve, reject) => {
          let claimed = false
          window.dispatchEvent(
            new CustomEvent<EditorSaveDirtyFilesDetail>(ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT, {
              detail: {
                claim: () => {
                  claimed = true
                },
                resolve,
                reject: (message) => {
                  reject(new Error(message))
                }
              }
            })
          )

          // Why: updater installs can run when no editor surface is mounted.
          // When nothing claims the request there are no in-memory editor buffers
          // to flush, so proceed with the normal shutdown path immediately.
          if (!claimed) {
            resolve()
          }
        })
      } catch (error) {
        console.warn(
          '[updater] Saving dirty files before quit failed; proceeding with install anyway:',
          error
        )
      }

      // Dispatch beforeunload to trigger terminal buffer capture before the
      // update process bypasses the normal window close sequence (quitAndInstall
      // removes close listeners, preventing beforeunload from firing naturally).
      window.dispatchEvent(new Event('beforeunload'))
      try {
        return await ipcRenderer.invoke('updater:quitAndInstall')
      } catch (error) {
        window.dispatchEvent(new Event(ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT))
        throw error
      }
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
    }> => ipcRenderer.invoke('fs:search', args),
    watchWorktree: (args: { worktreePath: string }): Promise<void> =>
      ipcRenderer.invoke('fs:watchWorktree', args),
    unwatchWorktree: (args: { worktreePath: string }): Promise<void> =>
      ipcRenderer.invoke('fs:unwatchWorktree', args),
    onFsChanged: (callback: (payload: FsChangedPayload) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: FsChangedPayload) =>
        callback(payload)
      ipcRenderer.on('fs:changed', listener)
      return () => ipcRenderer.removeListener('fs:changed', listener)
    }
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
    bulkStage: (args: { worktreePath: string; filePaths: string[] }): Promise<void> =>
      ipcRenderer.invoke('git:bulkStage', args),
    unstage: (args: { worktreePath: string; filePath: string }): Promise<void> =>
      ipcRenderer.invoke('git:unstage', args),
    bulkUnstage: (args: { worktreePath: string; filePaths: string[] }): Promise<void> =>
      ipcRenderer.invoke('git:bulkUnstage', args),
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
    onToggleWorktreePalette: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:toggleWorktreePalette', listener)
      return () => ipcRenderer.removeListener('ui:toggleWorktreePalette', listener)
    },
    onOpenQuickOpen: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:openQuickOpen', listener)
      return () => ipcRenderer.removeListener('ui:openQuickOpen', listener)
    },
    onJumpToWorktreeIndex: (callback: (index: number) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, index: number) => callback(index)
      ipcRenderer.on('ui:jumpToWorktreeIndex', listener)
      return () => ipcRenderer.removeListener('ui:jumpToWorktreeIndex', listener)
    },
    onNewBrowserTab: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:newBrowserTab', listener)
      return () => ipcRenderer.removeListener('ui:newBrowserTab', listener)
    },
    onNewTerminalTab: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:newTerminalTab', listener)
      return () => ipcRenderer.removeListener('ui:newTerminalTab', listener)
    },
    onCloseActiveTab: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:closeActiveTab', listener)
      return () => ipcRenderer.removeListener('ui:closeActiveTab', listener)
    },
    onSwitchTab: (callback: (direction: 1 | -1) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, direction: 1 | -1) => callback(direction)
      ipcRenderer.on('ui:switchTab', listener)
      return () => ipcRenderer.removeListener('ui:switchTab', listener)
    },
    onToggleStatusBar: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:toggleStatusBar', listener)
      return () => ipcRenderer.removeListener('ui:toggleStatusBar', listener)
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
    saveClipboardImageAsTempFile: (): Promise<string | null> =>
      ipcRenderer.invoke('clipboard:saveImageAsTempFile'),
    writeClipboardText: (text: string): Promise<void> =>
      ipcRenderer.invoke('clipboard:writeText', text),
    writeClipboardImage: (dataUrl: string): Promise<void> =>
      ipcRenderer.invoke('clipboard:writeImage', dataUrl),
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
    setZoomLevel: (level: number): void => webFrame.setZoomLevel(level),
    syncTrafficLights: (zoomFactor: number): void =>
      ipcRenderer.send('ui:sync-traffic-lights', zoomFactor),
    onFullscreenChanged: (callback: (isFullScreen: boolean) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, isFullScreen: boolean) =>
        callback(isFullScreen)
      ipcRenderer.on('window:fullscreen-changed', listener)
      return () => ipcRenderer.removeListener('window:fullscreen-changed', listener)
    },
    /** Fired by the main process when the user tries to close the window
     *  (X button, Cmd+Q, etc.). Renderer should show a confirmation dialog
     *  if terminals are still running, then call confirmWindowClose().
     *  When isQuitting is true, the close was initiated by app.quit() (Cmd+Q)
     *  and the renderer should skip the running-process dialog. */
    onWindowCloseRequested: (callback: (data: { isQuitting: boolean }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { isQuitting: boolean }) =>
        callback(data ?? { isQuitting: false })
      ipcRenderer.on('window:close-requested', listener)
      return () => ipcRenderer.removeListener('window:close-requested', listener)
    },
    /** Tell the main process to proceed with the window close. */
    confirmWindowClose: (): void => {
      ipcRenderer.send('window:confirm-close')
    }
  },

  stats: {
    getSummary: (): Promise<{
      totalAgentsSpawned: number
      totalPRsCreated: number
      totalAgentTimeMs: number
      firstEventAt: number | null
    }> => ipcRenderer.invoke('stats:summary')
  },

  claudeUsage: {
    getScanState: (): Promise<unknown> => ipcRenderer.invoke('claudeUsage:getScanState'),
    setEnabled: (args: { enabled: boolean }): Promise<unknown> =>
      ipcRenderer.invoke('claudeUsage:setEnabled', args),
    refresh: (args?: { force?: boolean }): Promise<unknown> =>
      ipcRenderer.invoke('claudeUsage:refresh', args),
    getSummary: (args: { scope: string; range: string }): Promise<unknown> =>
      ipcRenderer.invoke('claudeUsage:getSummary', args),
    getDaily: (args: { scope: string; range: string }): Promise<unknown> =>
      ipcRenderer.invoke('claudeUsage:getDaily', args),
    getBreakdown: (args: { scope: string; range: string; kind: string }): Promise<unknown> =>
      ipcRenderer.invoke('claudeUsage:getBreakdown', args),
    getRecentSessions: (args: { scope: string; range: string; limit?: number }): Promise<unknown> =>
      ipcRenderer.invoke('claudeUsage:getRecentSessions', args)
  },

  codexUsage: {
    getScanState: (): Promise<unknown> => ipcRenderer.invoke('codexUsage:getScanState'),
    setEnabled: (args: { enabled: boolean }): Promise<unknown> =>
      ipcRenderer.invoke('codexUsage:setEnabled', args),
    refresh: (args?: { force?: boolean }): Promise<unknown> =>
      ipcRenderer.invoke('codexUsage:refresh', args),
    getSummary: (args: { scope: string; range: string }): Promise<unknown> =>
      ipcRenderer.invoke('codexUsage:getSummary', args),
    getDaily: (args: { scope: string; range: string }): Promise<unknown> =>
      ipcRenderer.invoke('codexUsage:getDaily', args),
    getBreakdown: (args: { scope: string; range: string; kind: string }): Promise<unknown> =>
      ipcRenderer.invoke('codexUsage:getBreakdown', args),
    getRecentSessions: (args: { scope: string; range: string; limit?: number }): Promise<unknown> =>
      ipcRenderer.invoke('codexUsage:getRecentSessions', args)
  },

  runtime: {
    syncWindowGraph: (graph: RuntimeSyncWindowGraph): Promise<RuntimeStatus> =>
      ipcRenderer.invoke('runtime:syncWindowGraph', graph),
    getStatus: (): Promise<RuntimeStatus> => ipcRenderer.invoke('runtime:getStatus')
  },

  rateLimits: {
    get: (): Promise<RateLimitState> => ipcRenderer.invoke('rateLimits:get'),
    refresh: (): Promise<RateLimitState> => ipcRenderer.invoke('rateLimits:refresh'),
    setPollingInterval: (ms: number): Promise<void> =>
      ipcRenderer.invoke('rateLimits:setPollingInterval', ms),
    onUpdate: (callback: (state: RateLimitState) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: RateLimitState) => callback(state)
      ipcRenderer.on('rateLimits:update', listener)
      return () => ipcRenderer.removeListener('rateLimits:update', listener)
    }
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
