/* eslint-disable max-lines -- Why: the preload bridge is the audited contract between
renderer and Electron. Keeping the IPC surface co-located in one file makes security
review and type drift checks easier than scattering these bindings across modules. */
import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { preloadE2EConfig } from './e2e-config'
import type { CliInstallStatus } from '../shared/cli-install-types'
import type { AgentHookInstallStatus } from '../shared/agent-hook-types'
import type {
  BaseRefDefaultResult,
  BrowserViewportOverride,
  CreateWorktreeArgs,
  CustomPet,
  FsChangedPayload,
  GetRateLimitResult,
  GitHubAssignableUser,
  GitHubCommentResult,
  GitHubWorkItem,
  GitUpstreamStatus,
  GhosttyImportPreview,
  ListWorkItemsResult,
  MemorySnapshot,
  NotificationDispatchResult,
  NotificationPermissionStatusResult,
  NotificationSoundDataResult,
  NotificationSoundPathResult,
  NotificationSoundResult,
  OnboardingState,
  SearchResult,
  WorktreeBaseStatusEvent,
  WorktreeRemoteBranchConflictEvent
} from '../shared/types'
import type { RuntimeStatus, RuntimeSyncWindowGraph } from '../shared/runtime-types'
import type { RateLimitState } from '../shared/rate-limit-types'
import type { GhAuthDiagnostic } from '../shared/github-auth-types'
import type {
  AddIssueCommentBySlugArgs,
  ClearProjectItemFieldArgs,
  DeleteIssueCommentBySlugArgs,
  GetProjectViewTableArgs,
  GetProjectViewTableResult,
  GitHubProjectCommentMutationResult,
  GitHubProjectMutationResult,
  ListAccessibleProjectsResult,
  ListAssignableUsersBySlugArgs,
  ListAssignableUsersBySlugResult,
  ListIssueTypesBySlugArgs,
  ListIssueTypesBySlugResult,
  ListLabelsBySlugArgs,
  ListLabelsBySlugResult,
  ListProjectViewsArgs,
  ListProjectViewsResult,
  ProjectWorkItemDetailsBySlugArgs,
  ProjectWorkItemDetailsBySlugResult,
  ResolveProjectRefArgs,
  ResolveProjectRefResult,
  UpdateIssueBySlugArgs,
  UpdateIssueCommentBySlugArgs,
  UpdateIssueTypeBySlugArgs,
  UpdatePullRequestBySlugArgs,
  UpdateProjectItemFieldArgs
} from '../shared/github-project-types'
import {
  richMarkdownContextMenuCommandChannel,
  type RichMarkdownContextMenuCommandPayload
} from '../shared/rich-markdown-context-menu'
import type {
  SshConnectionState,
  SshTarget,
  PortForwardEntry,
  DetectedPort
} from '../shared/ssh-types'
import type { AgentStatusState } from '../shared/agent-status-types'
import type { TelemetryConsentState } from '../shared/telemetry-consent-types'
import type { AgentKind, LaunchSource, RequestKind } from '../shared/telemetry-events'
import {
  ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT,
  type EditorSaveDirtyFilesDetail
} from '../shared/editor-save-events'
import {
  ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT,
  ORCA_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT
} from '../shared/updater-renderer-events'

type NativeDropResolution =
  | { target: 'editor' }
  | { target: 'terminal' }
  | { target: 'composer' }
  | { target: 'file-explorer'; destinationDir: string }
  // Why: returned when the explorer marker was found but no destinationDir
  // could be resolved. The caller must suppress the drop entirely instead of
  // falling back to 'editor' — fail-closed behavior per design §7.1.
  | { target: 'rejected' }

// Why: one shared HTMLAudioElement per sound file, restarted from t=0 on each
// play, with an in-flight guard that drops new plays while the sound is still
// ringing. This mirrors VS Code's AccessibilitySignalService and GNOME's
// libcanberra: a burst of triggers self-dedupes by the sound's own duration
// (no magic time constant), while distinct sounds are still allowed to overlap.
// We also cache the decoded blob URL by path so we don't re-read 10MB from
// disk and re-transfer it over IPC on every notification.
let cachedNotificationSound: {
  path: string
  blobUrl: string
  audio: HTMLAudioElement
} | null = null
let isNotificationSoundPlaying = false

function disposeCachedNotificationSound(): void {
  if (cachedNotificationSound) {
    cachedNotificationSound.audio.pause()
    cachedNotificationSound.audio.src = ''
    URL.revokeObjectURL(cachedNotificationSound.blobUrl)
    cachedNotificationSound = null
  }
}

/**
 * Walk the composed event path to classify which UI surface the native OS drop
 * landed on, and — for file-explorer drops — extract the nearest destination
 * directory from `data-native-file-drop-dir`.
 *
 * Why: the preload layer consumes native OS `drop` events before React can read
 * filesystem paths. If preload does not capture the destination directory at
 * drop time, the renderer can no longer tell whether the user meant "root" or
 * "inside this folder".
 */
function resolveNativeFileDrop(event: DragEvent): NativeDropResolution | null {
  const path = event.composedPath()
  let foundExplorer = false
  let destinationDir: string | undefined

  for (const entry of path) {
    if (!(entry instanceof HTMLElement)) {
      continue
    }

    const target = entry.dataset.nativeFileDropTarget
    if (target === 'editor' || target === 'terminal' || target === 'composer') {
      return { target }
    }
    if (target === 'file-explorer') {
      foundExplorer = true
    }

    // Pick the nearest (innermost) destination directory marker
    if (destinationDir === undefined && entry.dataset.nativeFileDropDir) {
      destinationDir = entry.dataset.nativeFileDropDir
    }
  }

  if (foundExplorer) {
    // Why: routing must fail closed for explorer drops. If preload sees the
    // explorer target marker but cannot resolve a destinationDir, it rejects
    // the gesture and emits no fallback editor drop event.
    if (!destinationDir) {
      return { target: 'rejected' }
    }
    return { target: 'file-explorer', destinationDir }
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
    const resolution = resolveNativeFileDrop(e)

    const paths: string[] = []
    for (let i = 0; i < files.length; i++) {
      // webUtils.getPathForFile is the Electron 28+ replacement for File.path
      const filePath = webUtils.getPathForFile(files[i])
      if (filePath) {
        paths.push(filePath)
      }
    }

    if (paths.length === 0) {
      return
    }

    // Why: when the explorer marker was present but no destination directory
    // could be resolved, the gesture is rejected entirely — no fallback to
    // editor, per the fail-closed requirement in design §7.1.
    if (resolution?.target === 'rejected') {
      return
    }

    // Why: preload must emit exactly one native-drop event per drop gesture.
    // The preload layer already has the full FileList. Re-emitting one IPC
    // message per path and asking the renderer to reconstruct the gesture via
    // timing would be both fragile and slower under large drops.
    if (resolution?.target === 'file-explorer') {
      ipcRenderer.send('terminal:file-dropped-from-preload', {
        paths,
        target: 'file-explorer',
        destinationDir: resolution.destinationDir
      })
    } else {
      // Why: falls back to 'editor' so drops on surfaces without an explicit
      // marker (sidebar, editor body, etc.) preserve the prior open-in-editor
      // behavior instead of being silently discarded.
      ipcRenderer.send('terminal:file-dropped-from-preload', {
        paths,
        target: resolution?.target ?? 'editor'
      })
    }
  },
  true
)

// Custom APIs for renderer
const api = {
  app: {
    relaunch: (): Promise<void> => ipcRenderer.invoke('app:relaunch'),
    // Why: on macOS this returns AppleCurrentKeyboardLayoutInputSourceID so
    // the renderer's keyboard-layout probe can distinguish Polish Pro / US
    // Extended / ABC Extended / IME Roman modes from plain US QWERTY (see
    // src/renderer/src/lib/keyboard-layout/input-source-id.ts, issue #1205).
    // Returns null on non-Darwin or when the defaults read fails.
    getKeyboardInputSourceId: (): Promise<string | null> =>
      ipcRenderer.invoke('app:getKeyboardInputSourceId'),
    setUnreadDockBadgeCount: (count: number): Promise<void> =>
      ipcRenderer.invoke('app:setUnreadDockBadgeCount', count)
  },

  wsl: {
    isAvailable: (): Promise<boolean> => ipcRenderer.invoke('wsl:isAvailable')
  },

  pwsh: {
    isAvailable: (): Promise<boolean> => ipcRenderer.invoke('pwsh:isAvailable')
  },

  repos: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke('repos:list'),

    add: (args: { path: string; kind?: 'git' | 'folder' }): Promise<unknown> =>
      ipcRenderer.invoke('repos:add', args),

    addRemote: (args: {
      connectionId: string
      remotePath: string
      displayName?: string
      kind?: 'git' | 'folder'
    }): Promise<unknown> => ipcRenderer.invoke('repos:addRemote', args),

    create: (args: {
      parentPath: string
      name: string
      kind: 'git' | 'folder'
    }): Promise<unknown> => ipcRenderer.invoke('repos:create', args),

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

    getBaseRefDefault: (args: { repoId: string }): Promise<BaseRefDefaultResult> =>
      ipcRenderer.invoke('repos:getBaseRefDefault', args),

    searchBaseRefs: (args: { repoId: string; query: string; limit?: number }): Promise<string[]> =>
      ipcRenderer.invoke('repos:searchBaseRefs', args),

    onChanged: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('repos:changed', listener)
      return () => ipcRenderer.removeListener('repos:changed', listener)
    }
  },

  sparsePresets: {
    list: (args: { repoId: string }): Promise<unknown[]> =>
      ipcRenderer.invoke('sparsePresets:list', args),

    save: (args: {
      repoId: string
      id?: string
      name: string
      directories: string[]
    }): Promise<unknown> => ipcRenderer.invoke('sparsePresets:save', args),

    remove: (args: { repoId: string; presetId: string }): Promise<void> =>
      ipcRenderer.invoke('sparsePresets:remove', args),

    onChanged: (callback: (data: { repoId: string }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { repoId: string }) =>
        callback(data)
      ipcRenderer.on('sparsePresets:changed', listener)
      return () => ipcRenderer.removeListener('sparsePresets:changed', listener)
    }
  },

  worktrees: {
    list: (args: { repoId: string }): Promise<unknown[]> =>
      ipcRenderer.invoke('worktrees:list', args),

    listAll: (): Promise<unknown[]> => ipcRenderer.invoke('worktrees:listAll'),

    create: (args: CreateWorktreeArgs): Promise<unknown> =>
      ipcRenderer.invoke('worktrees:create', args),

    resolvePrBase: (args: {
      repoId: string
      prNumber: number
      headRefName?: string
      isCrossRepository?: boolean
    }): Promise<{ baseBranch: string } | { error: string }> =>
      ipcRenderer.invoke('worktrees:resolvePrBase', args),

    remove: (args: { worktreeId: string; force?: boolean; skipArchive?: boolean }): Promise<void> =>
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
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: WorktreeRemoteBranchConflictEvent
      ) => callback(data)
      ipcRenderer.on('worktree:remoteBranchConflict', listener)
      return () => ipcRenderer.removeListener('worktree:remoteBranchConflict', listener)
    }
  },

  pty: {
    spawn: (opts: {
      cols: number
      rows: number
      cwd?: string
      env?: Record<string, string>
      command?: string
      connectionId?: string | null
      worktreeId?: string
      sessionId?: string
      shellOverride?: string
      // Why: closes the SIGKILL race documented in INVESTIGATION.md by
      // letting main patch + sync-flush the (worktreeId, tabId, leafId →
      // ptyId) binding before pty:spawn returns. Only the renderer's
      // user-typing-Ctrl+T daemon-host path threads these.
      tabId?: string
      leafId?: string
      // Why: telemetry-plan.md§Agent launch semantics — main fires
      // `agent_started` only after the spawn succeeds. The renderer is the
      // source of truth for the launch metadata; main is the source of
      // truth for whether the launch happened. Loose typing here on
      // purpose: validation lives at the main-side schema validator.
      telemetry?: { agent_kind: AgentKind; launch_source: LaunchSource; request_kind: RequestKind }
    }): Promise<{
      id: string
      snapshot?: string
      snapshotCols?: number
      snapshotRows?: number
      isReattach?: boolean
      isAlternateScreen?: boolean
      replay?: string
      sessionExpired?: boolean
      coldRestore?: { scrollback: string; cwd: string }
    }> => ipcRenderer.invoke('pty:spawn', opts),

    write: (id: string, data: string): void => {
      ipcRenderer.send('pty:write', { id, data })
    },

    resize: (id: string, cols: number, rows: number): void => {
      ipcRenderer.send('pty:resize', { id, cols, rows })
    },

    /** Why: measurement-only sibling of resize. Fires when a desktop pane
     * container measures real geometry (e.g. previously hidden tab becomes
     * visible) so the runtime's restore-target baseline can stay fresh
     * even while a mobile-fit override blocks pty:resize. Never resizes
     * the PTY. See docs/mobile-fit-hold.md. */
    reportGeometry: (id: string, cols: number, rows: number): void => {
      ipcRenderer.send('pty:reportGeometry', { id, cols, rows })
    },

    signal: (id: string, signal: string): void => {
      ipcRenderer.send('pty:signal', { id, signal })
    },

    ackColdRestore: (id: string): void => {
      ipcRenderer.send('pty:ackColdRestore', { id })
    },

    kill: (id: string, opts?: { keepHistory?: boolean }): Promise<void> =>
      ipcRenderer.invoke('pty:kill', { id, keepHistory: opts?.keepHistory ?? false }),

    listSessions: (): Promise<{ id: string; cwd: string; title: string }[]> =>
      ipcRenderer.invoke('pty:listSessions'),

    /** Check if a PTY's shell has child processes (e.g. a running command).
     *  Returns false for an idle shell prompt. */
    hasChildProcesses: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('pty:hasChildProcesses', { id }),

    /** Return the PTY foreground process basename when available (e.g. "codex"). */
    getForegroundProcess: (id: string): Promise<string | null> =>
      ipcRenderer.invoke('pty:getForegroundProcess', { id }),

    /** Resolve the live cwd of a PTY via `/proc` (Linux) or `lsof` (macOS).
     *  Returns `''` when the id is unknown or the platform cannot resolve one. */
    getCwd: (id: string): Promise<string> => ipcRenderer.invoke('pty:getCwd', { id }),

    onData: (callback: (data: { id: string; data: string }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { id: string; data: string }) =>
        callback(data)
      ipcRenderer.on('pty:data', listener)
      return () => ipcRenderer.removeListener('pty:data', listener)
    },

    onReplay: (callback: (data: { id: string; data: string }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { id: string; data: string }) =>
        callback(data)
      ipcRenderer.on('pty:replay', listener)
      return () => ipcRenderer.removeListener('pty:replay', listener)
    },

    onExit: (callback: (data: { id: string; code: number }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { id: string; code: number }) =>
        callback(data)
      ipcRenderer.on('pty:exit', listener)
      return () => ipcRenderer.removeListener('pty:exit', listener)
    },

    onSerializeBufferRequest: (
      callback: (data: {
        requestId: string
        ptyId: string
        opts?: { scrollbackRows?: number; altScreenForcesZeroRows?: boolean }
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          requestId: string
          ptyId: string
          opts?: { scrollbackRows?: number; altScreenForcesZeroRows?: boolean }
        }
      ) => callback(data)
      ipcRenderer.on('pty:serializeBuffer:request', listener)
      return () => ipcRenderer.removeListener('pty:serializeBuffer:request', listener)
    },

    sendSerializedBuffer: (
      requestId: string,
      snapshot: { data: string; cols: number; rows: number; lastTitle?: string } | null
    ): void => {
      ipcRenderer.send('pty:serializeBuffer:response', { requestId, snapshot })
    },

    // Why: pre-signal handshake — renderer declares it will own the serializer
    // for `paneKey` BEFORE issuing pty:spawn so the cooperation gate in main
    // can suppress the daemon-snapshot seed. Returns a generation token that
    // the renderer must echo on settle/clear so paneKey-reuse during teardown
    // cannot defeat the pre-signal. See docs/mobile-prefer-renderer-scrollback.md.
    declarePendingPaneSerializer: (paneKey: string): Promise<number> =>
      ipcRenderer.invoke('pty:declarePendingPaneSerializer', { paneKey }),

    settlePaneSerializer: (paneKey: string, gen: number): Promise<void> =>
      ipcRenderer.invoke('pty:settlePaneSerializer', { paneKey, gen }),

    clearPendingPaneSerializer: (paneKey: string, gen: number): Promise<void> =>
      ipcRenderer.invoke('pty:clearPendingPaneSerializer', { paneKey, gen }),

    management: {
      listSessions: () => ipcRenderer.invoke('pty:management:listSessions'),
      killAll: () => ipcRenderer.invoke('pty:management:killAll'),
      killOne: (args: { sessionId: string }) => ipcRenderer.invoke('pty:management:killOne', args),
      restart: () => ipcRenderer.invoke('pty:management:restart')
    }
  },

  feedback: {
    submit: (args: {
      feedback: string
      submitAnonymously?: boolean
      githubLogin: string | null
      githubEmail: string | null
    }): Promise<{ ok: true } | { ok: false; status: number | null; error: string }> =>
      ipcRenderer.invoke('feedback:submit', args)
  },

  export: {
    htmlToPdf: (args: {
      html: string
      title: string
    }): Promise<
      { success: true; filePath: string } | { success: false; cancelled?: boolean; error?: string }
    > => ipcRenderer.invoke('export:html-to-pdf', args)
  },

  gh: {
    viewer: (): Promise<unknown> => ipcRenderer.invoke('gh:viewer'),

    repoSlug: (args: { repoPath: string }): Promise<unknown> =>
      ipcRenderer.invoke('gh:repoSlug', args),

    prForBranch: (args: {
      repoPath: string
      branch: string
      linkedPRNumber?: number | null
    }): Promise<unknown> => ipcRenderer.invoke('gh:prForBranch', args),

    issue: (args: { repoPath: string; number: number }): Promise<unknown> =>
      ipcRenderer.invoke('gh:issue', args),

    workItem: (args: {
      repoPath: string
      number: number
      type?: 'issue' | 'pr'
    }): Promise<unknown> => ipcRenderer.invoke('gh:workItem', args),

    workItemByOwnerRepo: (args: {
      repoPath: string
      owner: string
      repo: string
      number: number
      type: 'issue' | 'pr'
    }): Promise<unknown> => ipcRenderer.invoke('gh:workItemByOwnerRepo', args),

    workItemDetails: (args: {
      repoPath: string
      number: number
      type?: 'issue' | 'pr'
    }): Promise<unknown> => ipcRenderer.invoke('gh:workItemDetails', args),

    prFileContents: (args: {
      repoPath: string
      prNumber: number
      path: string
      oldPath?: string
      status: string
      headSha: string
      baseSha: string
    }): Promise<unknown> => ipcRenderer.invoke('gh:prFileContents', args),

    listIssues: (args: { repoPath: string; limit?: number }): Promise<unknown[]> =>
      ipcRenderer.invoke('gh:listIssues', args),

    createIssue: (args: {
      repoPath: string
      title: string
      body: string
    }): Promise<{ ok: true; number: number; url: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke('gh:createIssue', args),

    countWorkItems: (args: { repoPath: string; query?: string }): Promise<number> =>
      ipcRenderer.invoke('gh:countWorkItems', args),

    listWorkItems: (args: {
      repoPath: string
      limit?: number
      query?: string
      before?: string
    }): Promise<ListWorkItemsResult<Omit<GitHubWorkItem, 'repoId'>>> =>
      ipcRenderer.invoke('gh:listWorkItems', args),

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

    updateIssue: (args: {
      repoPath: string
      number: number
      updates: unknown
    }): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('gh:updateIssue', args),

    addIssueComment: (args: {
      repoPath: string
      number: number
      body: string
      type?: 'issue' | 'pr'
    }): Promise<GitHubCommentResult> => ipcRenderer.invoke('gh:addIssueComment', args),

    addPRReviewCommentReply: (args: {
      repoPath: string
      prNumber: number
      commentId: number
      body: string
      threadId?: string
      path?: string
      line?: number
    }): Promise<GitHubCommentResult> => ipcRenderer.invoke('gh:addPRReviewCommentReply', args),

    addPRReviewComment: (args: {
      repoPath: string
      prNumber: number
      commitId: string
      path: string
      line: number
      startLine?: number
      body: string
    }): Promise<GitHubCommentResult> => ipcRenderer.invoke('gh:addPRReviewComment', args),

    listLabels: (args: { repoPath: string }): Promise<string[]> =>
      ipcRenderer.invoke('gh:listLabels', args),

    listAssignableUsers: (args: { repoPath: string }): Promise<GitHubAssignableUser[]> =>
      ipcRenderer.invoke('gh:listAssignableUsers', args),

    // Why: every renderer subscribes to local mutation broadcasts so each
    // window's work-item-details cache invalidates the affected entry. The
    // event fires after a successful mutation in any window — see
    // src/main/ipc/github.ts broadcastWorkItemMutated.
    onWorkItemMutated: (
      callback: (payload: { repoPath: string; type: 'issue' | 'pr'; number: number }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: { repoPath: string; type: 'issue' | 'pr'; number: number }
      ): void => callback(payload)
      ipcRenderer.on('gh:workItemMutated', listener)
      return () => ipcRenderer.removeListener('gh:workItemMutated', listener)
    },

    checkOrcaStarred: (): Promise<boolean | null> => ipcRenderer.invoke('gh:checkOrcaStarred'),
    starOrca: (): Promise<boolean> => ipcRenderer.invoke('gh:starOrca'),

    // Why: rate_limit is exempt from rate-limit accounting, but we still pass
    // `force` through so callers can bust the 30s in-process cache after a
    // known-expensive op (e.g. after ProjectPicker discovery).
    rateLimit: (args?: { force?: boolean }): Promise<GetRateLimitResult> =>
      ipcRenderer.invoke('gh:rateLimit', args),

    diagnoseAuth: (): Promise<GhAuthDiagnostic> => ipcRenderer.invoke('gh:diagnoseAuth'),

    // ── ProjectV2 (GitHub Projects) ───────────────────────────────────
    listAccessibleProjects: (): Promise<ListAccessibleProjectsResult> =>
      ipcRenderer.invoke('gh:listAccessibleProjects'),
    resolveProjectRef: (args: ResolveProjectRefArgs): Promise<ResolveProjectRefResult> =>
      ipcRenderer.invoke('gh:resolveProjectRef', args),
    listProjectViews: (args: ListProjectViewsArgs): Promise<ListProjectViewsResult> =>
      ipcRenderer.invoke('gh:listProjectViews', args),
    getProjectViewTable: (args: GetProjectViewTableArgs): Promise<GetProjectViewTableResult> =>
      ipcRenderer.invoke('gh:getProjectViewTable', args),
    projectWorkItemDetailsBySlug: (
      args: ProjectWorkItemDetailsBySlugArgs
    ): Promise<ProjectWorkItemDetailsBySlugResult> =>
      ipcRenderer.invoke('gh:projectWorkItemDetailsBySlug', args),
    updateProjectItemField: (
      args: UpdateProjectItemFieldArgs
    ): Promise<GitHubProjectMutationResult> =>
      ipcRenderer.invoke('gh:updateProjectItemField', args),
    clearProjectItemField: (
      args: ClearProjectItemFieldArgs
    ): Promise<GitHubProjectMutationResult> => ipcRenderer.invoke('gh:clearProjectItemField', args),
    updateIssueBySlug: (args: UpdateIssueBySlugArgs): Promise<GitHubProjectMutationResult> =>
      ipcRenderer.invoke('gh:updateIssueBySlug', args),
    updatePullRequestBySlug: (
      args: UpdatePullRequestBySlugArgs
    ): Promise<GitHubProjectMutationResult> =>
      ipcRenderer.invoke('gh:updatePullRequestBySlug', args),
    addIssueCommentBySlug: (
      args: AddIssueCommentBySlugArgs
    ): Promise<GitHubProjectCommentMutationResult> =>
      ipcRenderer.invoke('gh:addIssueCommentBySlug', args),
    updateIssueCommentBySlug: (
      args: UpdateIssueCommentBySlugArgs
    ): Promise<GitHubProjectMutationResult> =>
      ipcRenderer.invoke('gh:updateIssueCommentBySlug', args),
    deleteIssueCommentBySlug: (
      args: DeleteIssueCommentBySlugArgs
    ): Promise<GitHubProjectMutationResult> =>
      ipcRenderer.invoke('gh:deleteIssueCommentBySlug', args),
    listLabelsBySlug: (args: ListLabelsBySlugArgs): Promise<ListLabelsBySlugResult> =>
      ipcRenderer.invoke('gh:listLabelsBySlug', args),
    listAssignableUsersBySlug: (
      args: ListAssignableUsersBySlugArgs
    ): Promise<ListAssignableUsersBySlugResult> =>
      ipcRenderer.invoke('gh:listAssignableUsersBySlug', args),
    listIssueTypesBySlug: (args: ListIssueTypesBySlugArgs): Promise<ListIssueTypesBySlugResult> =>
      ipcRenderer.invoke('gh:listIssueTypesBySlug', args),
    updateIssueTypeBySlug: (
      args: UpdateIssueTypeBySlugArgs
    ): Promise<GitHubProjectMutationResult> => ipcRenderer.invoke('gh:updateIssueTypeBySlug', args)
  },

  linear: {
    connect: (args: {
      apiKey: string
    }): Promise<{ ok: true; viewer: unknown } | { ok: false; error: string }> =>
      ipcRenderer.invoke('linear:connect', args),

    disconnect: (): Promise<void> => ipcRenderer.invoke('linear:disconnect'),

    status: (): Promise<unknown> => ipcRenderer.invoke('linear:status'),

    testConnection: (): Promise<{ ok: true; viewer: unknown } | { ok: false; error: string }> =>
      ipcRenderer.invoke('linear:testConnection'),

    searchIssues: (args: { query: string; limit?: number }): Promise<unknown[]> =>
      ipcRenderer.invoke('linear:searchIssues', args),

    listIssues: (args?: {
      filter?: 'assigned' | 'created' | 'all' | 'completed'
      limit?: number
    }): Promise<unknown[]> => ipcRenderer.invoke('linear:listIssues', args),

    createIssue: (args: {
      teamId: string
      title: string
      description?: string
    }): Promise<
      { ok: true; id: string; identifier: string; url: string } | { ok: false; error: string }
    > => ipcRenderer.invoke('linear:createIssue', args),

    getIssue: (args: { id: string }): Promise<unknown> =>
      ipcRenderer.invoke('linear:getIssue', args),

    updateIssue: (args: {
      id: string
      updates: unknown
    }): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('linear:updateIssue', args),

    addIssueComment: (args: {
      issueId: string
      body: string
    }): Promise<{ ok: true; id: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke('linear:addIssueComment', args),

    issueComments: (args: { issueId: string }): Promise<unknown[]> =>
      ipcRenderer.invoke('linear:issueComments', args),

    listTeams: (): Promise<unknown[]> => ipcRenderer.invoke('linear:listTeams'),

    teamStates: (args: { teamId: string }): Promise<unknown[]> =>
      ipcRenderer.invoke('linear:teamStates', args),

    teamLabels: (args: { teamId: string }): Promise<unknown[]> =>
      ipcRenderer.invoke('linear:teamLabels', args),

    teamMembers: (args: { teamId: string }): Promise<unknown[]> =>
      ipcRenderer.invoke('linear:teamMembers', args)
  },

  starNag: {
    onShow: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent): void => callback()
      ipcRenderer.on('star-nag:show', listener)
      return () => ipcRenderer.removeListener('star-nag:show', listener)
    },
    dismiss: (): Promise<void> => ipcRenderer.invoke('star-nag:dismiss'),
    complete: (): Promise<void> => ipcRenderer.invoke('star-nag:complete'),
    forceShow: (): Promise<void> => ipcRenderer.invoke('star-nag:forceShow')
  },

  // Why: telemetry uses a loose untyped surface at the preload boundary on
  // purpose — the main-side validator (src/main/telemetry/validator.ts) is
  // the single enforcement point, not the preload types. The renderer gets
  // typed `track<N>()` / `setOptIn()` wrappers via
  // src/renderer/src/lib/telemetry.ts, which is what call sites import.
  telemetryTrack: (name: string, props: Record<string, unknown>): Promise<void> =>
    ipcRenderer.invoke('telemetry:track', name, props),
  telemetrySetOptIn: (optedIn: boolean): Promise<void> =>
    ipcRenderer.invoke('telemetry:setOptIn', optedIn),
  telemetryAcknowledgeBanner: (): Promise<void> =>
    ipcRenderer.invoke('telemetry:acknowledgeBanner'),
  telemetryGetConsentState: (): Promise<TelemetryConsentState> =>
    ipcRenderer.invoke('telemetry:getConsentState'),

  settings: {
    get: (): Promise<unknown> => ipcRenderer.invoke('settings:get'),

    set: (args: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('settings:set', args),

    listFonts: (): Promise<string[]> => ipcRenderer.invoke('settings:listFonts'),

    previewGhosttyImport: (): Promise<GhosttyImportPreview> =>
      ipcRenderer.invoke('settings:previewGhosttyImport'),

    onChanged: (callback: (updates: Record<string, unknown>) => void): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        updates: Record<string, unknown>
      ): void => callback(updates)
      ipcRenderer.on('settings:changed', listener)
      return () => ipcRenderer.removeListener('settings:changed', listener)
    }
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

  claudeAccounts: {
    list: (): Promise<unknown> => ipcRenderer.invoke('claudeAccounts:list'),
    add: (): Promise<unknown> => ipcRenderer.invoke('claudeAccounts:add'),
    reauthenticate: (args: { accountId: string }): Promise<unknown> =>
      ipcRenderer.invoke('claudeAccounts:reauthenticate', args),
    remove: (args: { accountId: string }): Promise<unknown> =>
      ipcRenderer.invoke('claudeAccounts:remove', args),
    select: (args: { accountId: string | null }): Promise<unknown> =>
      ipcRenderer.invoke('claudeAccounts:select', args)
  },

  cli: {
    getInstallStatus: (): Promise<CliInstallStatus> => ipcRenderer.invoke('cli:getInstallStatus'),
    install: (): Promise<CliInstallStatus> => ipcRenderer.invoke('cli:install'),
    remove: (): Promise<CliInstallStatus> => ipcRenderer.invoke('cli:remove')
  },

  agentHooks: {
    claudeStatus: (): Promise<AgentHookInstallStatus> =>
      ipcRenderer.invoke('agentHooks:claudeStatus'),
    codexStatus: (): Promise<AgentHookInstallStatus> =>
      ipcRenderer.invoke('agentHooks:codexStatus'),
    geminiStatus: (): Promise<AgentHookInstallStatus> =>
      ipcRenderer.invoke('agentHooks:geminiStatus'),
    cursorStatus: (): Promise<AgentHookInstallStatus> =>
      ipcRenderer.invoke('agentHooks:cursorStatus')
  },

  agentTrust: {
    markTrusted: (args: { preset: 'cursor' | 'copilot'; workspacePath: string }): Promise<void> =>
      ipcRenderer.invoke('agentTrust:markTrusted', args)
  },

  preflight: {
    check: (args?: {
      force?: boolean
    }): Promise<{
      git: { installed: boolean }
      gh: { installed: boolean; authenticated: boolean }
      linear: { connected: boolean }
    }> => ipcRenderer.invoke('preflight:check', args),
    detectAgents: (): Promise<string[]> => ipcRenderer.invoke('preflight:detectAgents'),
    refreshAgents: (): Promise<{
      agents: string[]
      addedPathSegments: string[]
      shellHydrationOk: boolean
    }> => ipcRenderer.invoke('preflight:refreshAgents'),
    detectRemoteAgents: (args: { connectionId: string }): Promise<string[]> =>
      ipcRenderer.invoke('preflight:detectRemoteAgents', args)
  },

  notifications: {
    dispatch: (args: Record<string, unknown>): Promise<NotificationDispatchResult> =>
      ipcRenderer.invoke('notifications:dispatch', args),
    openSystemSettings: (): Promise<void> => ipcRenderer.invoke('notifications:openSystemSettings'),
    getPermissionStatus: (): Promise<NotificationPermissionStatusResult> =>
      ipcRenderer.invoke('notifications:getPermissionStatus'),
    requestPermission: (): Promise<NotificationPermissionStatusResult> =>
      ipcRenderer.invoke('notifications:requestPermission'),
    playSound: async (options?: { force?: boolean }): Promise<NotificationSoundResult> => {
      try {
        // Why: drop replays while the sound is still ringing. The "test"
        // button bypasses with force so the user always hears a confirmation.
        if (!options?.force && isNotificationSoundPlaying) {
          return { played: false, reason: 'deduped' }
        }

        const resolved = (await ipcRenderer.invoke(
          'notifications:resolveSoundPath'
        )) as NotificationSoundPathResult
        if (!resolved.ok) {
          if (cachedNotificationSound) {
            disposeCachedNotificationSound()
          }
          return { played: false, reason: resolved.reason }
        }

        let entry = cachedNotificationSound
        if (!entry || entry.path !== resolved.path) {
          const sound = (await ipcRenderer.invoke(
            'notifications:loadSound'
          )) as NotificationSoundDataResult
          if (!sound.ok) {
            disposeCachedNotificationSound()
            return { played: false, reason: sound.reason }
          }
          const arrayBuffer = new ArrayBuffer(sound.data.byteLength)
          new Uint8Array(arrayBuffer).set(sound.data)
          const blob = new Blob([arrayBuffer], { type: sound.mimeType })
          disposeCachedNotificationSound()
          const blobUrl = URL.createObjectURL(blob)
          entry = { path: sound.path, blobUrl, audio: new Audio(blobUrl) }
          cachedNotificationSound = entry
        }

        const audio = entry.audio
        // Why: restart-from-zero on every play so a burst of triggers replays
        // the sound from the start instead of stacking overlapping copies.
        // Matches GNOME canberra and VS Code AccessibilitySignalService.
        audio.currentTime = 0
        isNotificationSoundPlaying = true
        const release = (): void => {
          isNotificationSoundPlaying = false
        }
        audio.addEventListener('ended', release, { once: true })
        audio.addEventListener('error', release, { once: true })
        try {
          await audio.play()
        } catch {
          release()
          return { played: false, reason: 'playback-failed' }
        }
        return { played: true }
      } catch {
        isNotificationSoundPlaying = false
        return { played: false, reason: 'playback-failed' }
      }
    }
  },

  onboarding: {
    get: (): Promise<OnboardingState> => ipcRenderer.invoke('onboarding:get'),
    update: (
      updates: Partial<Omit<OnboardingState, 'checklist'>> & {
        checklist?: Partial<OnboardingState['checklist']>
      }
    ): Promise<OnboardingState> => ipcRenderer.invoke('onboarding:update', updates)
  },

  developerPermissions: {
    getStatus: (): Promise<unknown> => ipcRenderer.invoke('developerPermissions:getStatus'),
    request: (args: { id: string }): Promise<unknown> =>
      ipcRenderer.invoke('developerPermissions:request', args),
    openSettings: (args: { id: string }): Promise<void> =>
      ipcRenderer.invoke('developerPermissions:openSettings', args)
  },

  shell: {
    openPath: (path: string): Promise<void> => ipcRenderer.invoke('shell:openPath', path),

    openUrl: (url: string): Promise<void> => ipcRenderer.invoke('shell:openUrl', url),

    openFilePath: (path: string): Promise<void> => ipcRenderer.invoke('shell:openFilePath', path),

    openFileUri: (uri: string): Promise<void> => ipcRenderer.invoke('shell:openFileUri', uri),

    pathExists: (path: string): Promise<boolean> => ipcRenderer.invoke('shell:pathExists', path),

    pickAttachment: (): Promise<string | null> => ipcRenderer.invoke('shell:pickAttachment'),

    pickImage: (): Promise<string | null> => ipcRenderer.invoke('shell:pickImage'),

    pickAudio: (): Promise<string | null> => ipcRenderer.invoke('shell:pickAudio'),

    pickDirectory: (args: { defaultPath?: string }): Promise<string | null> =>
      ipcRenderer.invoke('shell:pickDirectory', args),

    copyFile: (args: { srcPath: string; destPath: string }): Promise<void> =>
      ipcRenderer.invoke('shell:copyFile', args)
  },

  pet: {
    import: (): Promise<CustomPet | null> => ipcRenderer.invoke('pet:import'),
    importPetBundle: (): Promise<CustomPet | null> => ipcRenderer.invoke('pet:importPetBundle'),
    read: (id: string, fileName: string, kind?: 'image' | 'bundle'): Promise<ArrayBuffer | null> =>
      ipcRenderer.invoke('pet:read', id, fileName, kind),
    delete: (id: string, fileName: string, kind?: 'image' | 'bundle'): Promise<void> =>
      ipcRenderer.invoke('pet:delete', id, fileName, kind)
  },

  browser: {
    registerGuest: (args: {
      browserPageId: string
      workspaceId: string
      worktreeId: string
      sessionProfileId?: string | null
      webContentsId: number
    }): Promise<void> => ipcRenderer.invoke('browser:registerGuest', args),

    unregisterGuest: (args: { browserPageId: string }): Promise<void> =>
      ipcRenderer.invoke('browser:unregisterGuest', args),

    openDevTools: (args: { browserPageId: string }): Promise<boolean> =>
      ipcRenderer.invoke('browser:openDevTools', args),

    setViewportOverride: (args: {
      browserPageId: string
      override: BrowserViewportOverride | null
    }): Promise<boolean> => ipcRenderer.invoke('browser:setViewportOverride', args),

    onGuestLoadFailed: (
      callback: (args: {
        browserPageId: string
        loadError: { code: number; description: string; validatedUrl: string }
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          browserPageId: string
          loadError: { code: number; description: string; validatedUrl: string }
        }
      ) => callback(data)
      ipcRenderer.on('browser:guest-load-failed', listener)
      return () => ipcRenderer.removeListener('browser:guest-load-failed', listener)
    },

    onPermissionDenied: (
      callback: (event: { browserPageId: string; permission: string; origin: string }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { browserPageId: string; permission: string; origin: string }
      ) => callback(data)
      ipcRenderer.on('browser:permission-denied', listener)
      return () => ipcRenderer.removeListener('browser:permission-denied', listener)
    },

    onPopup: (
      callback: (event: {
        browserPageId: string
        origin: string
        action: 'opened-external' | 'blocked'
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          browserPageId: string
          origin: string
          action: 'opened-external' | 'blocked'
        }
      ) => callback(data)
      ipcRenderer.on('browser:popup', listener)
      return () => ipcRenderer.removeListener('browser:popup', listener)
    },

    onDownloadRequested: (
      callback: (event: {
        browserPageId: string
        downloadId: string
        origin: string
        filename: string
        totalBytes: number | null
        mimeType: string | null
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          browserPageId: string
          downloadId: string
          origin: string
          filename: string
          totalBytes: number | null
          mimeType: string | null
        }
      ) => callback(data)
      ipcRenderer.on('browser:download-requested', listener)
      return () => ipcRenderer.removeListener('browser:download-requested', listener)
    },

    onDownloadProgress: (
      callback: (event: {
        downloadId: string
        receivedBytes: number
        totalBytes: number | null
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { downloadId: string; receivedBytes: number; totalBytes: number | null }
      ) => callback(data)
      ipcRenderer.on('browser:download-progress', listener)
      return () => ipcRenderer.removeListener('browser:download-progress', listener)
    },

    onDownloadFinished: (
      callback: (event: {
        downloadId: string
        status: 'completed' | 'canceled' | 'failed'
        savePath: string | null
        error: string | null
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          downloadId: string
          status: 'completed' | 'canceled' | 'failed'
          savePath: string | null
          error: string | null
        }
      ) => callback(data)
      ipcRenderer.on('browser:download-finished', listener)
      return () => ipcRenderer.removeListener('browser:download-finished', listener)
    },

    onContextMenuRequested: (
      callback: (event: {
        browserPageId: string
        x: number
        y: number
        screenX: number
        screenY: number
        pageUrl: string
        linkUrl: string | null
        canGoBack: boolean
        canGoForward: boolean
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          browserPageId: string
          x: number
          y: number
          screenX: number
          screenY: number
          pageUrl: string
          linkUrl: string | null
          canGoBack: boolean
          canGoForward: boolean
        }
      ) => callback(data)
      ipcRenderer.on('browser:context-menu-requested', listener)
      return () => ipcRenderer.removeListener('browser:context-menu-requested', listener)
    },

    onContextMenuDismissed: (
      callback: (event: { browserPageId: string }) => void
    ): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { browserPageId: string }) =>
        callback(data)
      ipcRenderer.on('browser:context-menu-dismissed', listener)
      return () => ipcRenderer.removeListener('browser:context-menu-dismissed', listener)
    },

    onNavigationUpdate: (
      callback: (event: { browserPageId: string; url: string; title: string }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { browserPageId: string; url: string; title: string }
      ) => callback(data)
      ipcRenderer.on('browser:navigation-update', listener)
      return () => ipcRenderer.removeListener('browser:navigation-update', listener)
    },

    onActivateView: (callback: (data: { worktreeId: string }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { worktreeId: string }) =>
        callback(data)
      ipcRenderer.on('browser:activateView', listener)
      return () => ipcRenderer.removeListener('browser:activateView', listener)
    },

    onPaneFocus: (
      callback: (data: { worktreeId: string | null; browserPageId: string }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { worktreeId: string | null; browserPageId: string }
      ) => callback(data)
      ipcRenderer.on('browser:pane-focus', listener)
      return () => ipcRenderer.removeListener('browser:pane-focus', listener)
    },

    onOpenLinkInOrcaTab: (
      callback: (event: { browserPageId: string; url: string }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { browserPageId: string; url: string }
      ) => callback(data)
      ipcRenderer.on('browser:open-link-in-orca-tab', listener)
      return () => ipcRenderer.removeListener('browser:open-link-in-orca-tab', listener)
    },

    acceptDownload: (args: {
      downloadId: string
    }): Promise<{ ok: true } | { ok: false; reason: string }> =>
      ipcRenderer.invoke('browser:acceptDownload', args),

    cancelDownload: (args: { downloadId: string }): Promise<boolean> =>
      ipcRenderer.invoke('browser:cancelDownload', args),

    setGrabMode: (args: {
      browserPageId: string
      enabled: boolean
    }): Promise<{ ok: true } | { ok: false; reason: string }> =>
      ipcRenderer.invoke('browser:setGrabMode', args),

    awaitGrabSelection: (args: { browserPageId: string; opId: string }): Promise<unknown> =>
      ipcRenderer.invoke('browser:awaitGrabSelection', args),

    cancelGrab: (args: { browserPageId: string }): Promise<boolean> =>
      ipcRenderer.invoke('browser:cancelGrab', args),

    captureSelectionScreenshot: (args: {
      browserPageId: string
      rect: { x: number; y: number; width: number; height: number }
    }): Promise<{ ok: true; screenshot: unknown } | { ok: false; reason: string }> =>
      ipcRenderer.invoke('browser:captureSelectionScreenshot', args),

    extractHoverPayload: (args: {
      browserPageId: string
    }): Promise<{ ok: true; payload: unknown } | { ok: false; reason: string }> =>
      ipcRenderer.invoke('browser:extractHoverPayload', args),

    onGrabModeToggle: (callback: (browserPageId: string) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, browserPageId: string) =>
        callback(browserPageId)
      ipcRenderer.on('browser:grabModeToggle', listener)
      return () => ipcRenderer.removeListener('browser:grabModeToggle', listener)
    },

    onGrabActionShortcut: (
      callback: (args: { browserPageId: string; key: 'c' | 's' }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { browserPageId: string; key: 'c' | 's' }
      ) => callback(data)
      ipcRenderer.on('browser:grabActionShortcut', listener)
      return () => ipcRenderer.removeListener('browser:grabActionShortcut', listener)
    },

    sessionListProfiles: (): Promise<unknown[]> =>
      ipcRenderer.invoke('browser:session:listProfiles'),

    sessionCreateProfile: (args: {
      scope: 'default' | 'isolated' | 'imported'
      label: string
    }): Promise<unknown> => ipcRenderer.invoke('browser:session:createProfile', args),

    sessionDeleteProfile: (args: { profileId: string }): Promise<boolean> =>
      ipcRenderer.invoke('browser:session:deleteProfile', args),

    sessionImportCookies: (args: {
      profileId: string
    }): Promise<
      { ok: true; profileId: string; summary: unknown } | { ok: false; reason: string }
    > => ipcRenderer.invoke('browser:session:importCookies', args),

    sessionResolvePartition: (args: { profileId: string | null }): Promise<string | null> =>
      ipcRenderer.invoke('browser:session:resolvePartition', args),

    sessionDetectBrowsers: (): Promise<unknown[]> =>
      ipcRenderer.invoke('browser:session:detectBrowsers'),

    sessionImportFromBrowser: (args: {
      profileId: string
      browserFamily: string
    }): Promise<
      { ok: true; profileId: string; summary: unknown } | { ok: false; reason: string }
    > => ipcRenderer.invoke('browser:session:importFromBrowser', args),

    sessionClearDefaultCookies: (): Promise<boolean> =>
      ipcRenderer.invoke('browser:session:clearDefaultCookies'),

    notifyActiveTabChanged: (args: { browserPageId: string }): Promise<boolean> =>
      ipcRenderer.invoke('browser:activeTabChanged', args)
  },

  hooks: {
    check: (args: {
      repoId: string
    }): Promise<{ hasHooks: boolean; hooks: unknown; mayNeedUpdate: boolean }> =>
      ipcRenderer.invoke('hooks:check', args),

    createIssueCommandRunner: (args: {
      repoId: string
      worktreePath: string
      command: string
    }): Promise<{ runnerScriptPath: string; envVars: Record<string, string> }> =>
      ipcRenderer.invoke('hooks:createIssueCommandRunner', args),

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
    check: (options?: { includePrerelease?: boolean }): Promise<void> =>
      ipcRenderer.invoke('updater:check', options),
    download: (): Promise<void> => ipcRenderer.invoke('updater:download'),
    dismissNudge: (): Promise<void> => ipcRenderer.invoke('updater:dismissNudge'),
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
    },
    onClearDismissal: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('updater:clearDismissal', listener)
      return () => ipcRenderer.removeListener('updater:clearDismissal', listener)
    }
  },

  fs: {
    readDir: (args: {
      dirPath: string
      connectionId?: string
    }): Promise<{ name: string; isDirectory: boolean; isSymlink: boolean }[]> =>
      ipcRenderer.invoke('fs:readDir', args),
    readFile: (args: {
      filePath: string
      connectionId?: string
    }): Promise<{ content: string; isBinary: boolean; isImage?: boolean; mimeType?: string }> =>
      ipcRenderer.invoke('fs:readFile', args),
    listMarkdownDocuments: (args: {
      rootPath: string
      connectionId?: string
    }): Promise<{ filePath: string; relativePath: string; basename: string; name: string }[]> =>
      ipcRenderer.invoke('fs:listMarkdownDocuments', args),
    writeFile: (args: {
      filePath: string
      content: string
      connectionId?: string
    }): Promise<void> => ipcRenderer.invoke('fs:writeFile', args),
    createFile: (args: { filePath: string; connectionId?: string }): Promise<void> =>
      ipcRenderer.invoke('fs:createFile', args),
    createDir: (args: { dirPath: string; connectionId?: string }): Promise<void> =>
      ipcRenderer.invoke('fs:createDir', args),
    rename: (args: { oldPath: string; newPath: string; connectionId?: string }): Promise<void> =>
      ipcRenderer.invoke('fs:rename', args),
    deletePath: (args: {
      targetPath: string
      connectionId?: string
      recursive?: boolean
    }): Promise<void> => ipcRenderer.invoke('fs:deletePath', args),
    authorizeExternalPath: (args: { targetPath: string }): Promise<void> =>
      ipcRenderer.invoke('fs:authorizeExternalPath', args),
    stat: (args: {
      filePath: string
      connectionId?: string
    }): Promise<{ size: number; isDirectory: boolean; mtime: number }> =>
      ipcRenderer.invoke('fs:stat', args),
    listFiles: (args: {
      rootPath: string
      connectionId?: string
      excludePaths?: string[]
    }): Promise<string[]> => ipcRenderer.invoke('fs:listFiles', args),
    search: (args: {
      query: string
      rootPath: string
      caseSensitive?: boolean
      wholeWord?: boolean
      useRegex?: boolean
      includePattern?: string
      excludePattern?: string
      maxResults?: number
      connectionId?: string
    }): Promise<SearchResult> => ipcRenderer.invoke('fs:search', args),
    importExternalPaths: (args: {
      sourcePaths: string[]
      destDir: string
      connectionId?: string
    }): Promise<{
      results: (
        | {
            sourcePath: string
            status: 'imported'
            destPath: string
            kind: 'file' | 'directory'
            renamed: boolean
          }
        | {
            sourcePath: string
            status: 'skipped'
            reason: 'missing' | 'symlink' | 'permission-denied' | 'unsupported'
          }
        | {
            sourcePath: string
            status: 'failed'
            reason: string
          }
      )[]
    }> => ipcRenderer.invoke('fs:importExternalPaths', args),
    resolveDroppedPathsForAgent: (args: {
      paths: string[]
      worktreePath: string
      connectionId?: string
    }): Promise<{
      resolvedPaths: string[]
      skipped: {
        sourcePath: string
        reason: 'missing' | 'symlink' | 'permission-denied' | 'unsupported'
      }[]
      failed: { sourcePath: string; reason: string }[]
    }> => ipcRenderer.invoke('fs:resolveDroppedPathsForAgent', args),
    watchWorktree: (args: { worktreePath: string; connectionId?: string }): Promise<void> =>
      ipcRenderer.invoke('fs:watchWorktree', args),
    unwatchWorktree: (args: { worktreePath: string; connectionId?: string }): Promise<void> =>
      ipcRenderer.invoke('fs:unwatchWorktree', args),
    onFsChanged: (callback: (payload: FsChangedPayload) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: FsChangedPayload) =>
        callback(payload)
      ipcRenderer.on('fs:changed', listener)
      return () => ipcRenderer.removeListener('fs:changed', listener)
    }
  },

  git: {
    status: (args: { worktreePath: string; connectionId?: string }): Promise<unknown> =>
      ipcRenderer.invoke('git:status', args),
    conflictOperation: (args: { worktreePath: string; connectionId?: string }): Promise<unknown> =>
      ipcRenderer.invoke('git:conflictOperation', args),
    diff: (args: {
      worktreePath: string
      filePath: string
      staged: boolean
      compareAgainstHead?: boolean
      connectionId?: string
    }): Promise<unknown> => ipcRenderer.invoke('git:diff', args),
    branchCompare: (args: {
      worktreePath: string
      baseRef: string
      connectionId?: string
    }): Promise<unknown> => ipcRenderer.invoke('git:branchCompare', args),
    upstreamStatus: (args: {
      worktreePath: string
      connectionId?: string
    }): Promise<GitUpstreamStatus> => ipcRenderer.invoke('git:upstreamStatus', args),
    fetch: (args: { worktreePath: string; connectionId?: string }): Promise<void> =>
      ipcRenderer.invoke('git:fetch', args),
    push: (args: {
      worktreePath: string
      publish?: boolean
      connectionId?: string
    }): Promise<void> => ipcRenderer.invoke('git:push', args),
    pull: (args: { worktreePath: string; connectionId?: string }): Promise<void> =>
      ipcRenderer.invoke('git:pull', args),
    branchDiff: (args: {
      worktreePath: string
      compare: { baseRef: string; baseOid: string; headOid: string; mergeBase: string }
      filePath: string
      oldPath?: string
      connectionId?: string
    }): Promise<unknown> => ipcRenderer.invoke('git:branchDiff', args),
    commit: (args: {
      worktreePath: string
      message: string
      connectionId?: string
    }): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('git:commit', args),
    stage: (args: {
      worktreePath: string
      filePath: string
      connectionId?: string
    }): Promise<void> => ipcRenderer.invoke('git:stage', args),
    bulkStage: (args: {
      worktreePath: string
      filePaths: string[]
      connectionId?: string
    }): Promise<void> => ipcRenderer.invoke('git:bulkStage', args),
    unstage: (args: {
      worktreePath: string
      filePath: string
      connectionId?: string
    }): Promise<void> => ipcRenderer.invoke('git:unstage', args),
    bulkUnstage: (args: {
      worktreePath: string
      filePaths: string[]
      connectionId?: string
    }): Promise<void> => ipcRenderer.invoke('git:bulkUnstage', args),
    discard: (args: {
      worktreePath: string
      filePath: string
      connectionId?: string
    }): Promise<void> => ipcRenderer.invoke('git:discard', args),
    remoteFileUrl: (args: {
      worktreePath: string
      relativePath: string
      line: number
      connectionId?: string
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
    onToggleLeftSidebar: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:toggleLeftSidebar', listener)
      return () => ipcRenderer.removeListener('ui:toggleLeftSidebar', listener)
    },
    onToggleRightSidebar: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:toggleRightSidebar', listener)
      return () => ipcRenderer.removeListener('ui:toggleRightSidebar', listener)
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
    onOpenNewWorkspace: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:openNewWorkspace', listener)
      return () => ipcRenderer.removeListener('ui:openNewWorkspace', listener)
    },
    onJumpToWorktreeIndex: (callback: (index: number) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, index: number) => callback(index)
      ipcRenderer.on('ui:jumpToWorktreeIndex', listener)
      return () => ipcRenderer.removeListener('ui:jumpToWorktreeIndex', listener)
    },
    onWorktreeHistoryNavigate: (
      callback: (direction: 'back' | 'forward') => void
    ): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, direction: 'back' | 'forward') =>
        callback(direction)
      ipcRenderer.on('ui:worktreeHistoryNavigate', listener)
      return () => ipcRenderer.removeListener('ui:worktreeHistoryNavigate', listener)
    },
    onNewBrowserTab: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:newBrowserTab', listener)
      return () => ipcRenderer.removeListener('ui:newBrowserTab', listener)
    },
    onRequestTabCreate: (
      callback: (data: {
        requestId: string
        url: string
        worktreeId?: string
        sessionProfileId?: string
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { requestId: string; url: string; worktreeId?: string; sessionProfileId?: string }
      ) => callback(data)
      ipcRenderer.on('browser:requestTabCreate', listener)
      return () => ipcRenderer.removeListener('browser:requestTabCreate', listener)
    },
    replyTabCreate: (reply: {
      requestId: string
      browserPageId?: string
      error?: string
    }): void => {
      ipcRenderer.send('browser:tabCreateReply', reply)
    },
    onRequestTabSetProfile: (
      callback: (data: { requestId: string; browserPageId: string; profileId: string }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { requestId: string; browserPageId: string; profileId: string }
      ) => callback(data)
      ipcRenderer.on('browser:requestTabSetProfile', listener)
      return () => ipcRenderer.removeListener('browser:requestTabSetProfile', listener)
    },
    replyTabSetProfile: (reply: { requestId: string; error?: string }): void => {
      ipcRenderer.send('browser:tabSetProfileReply', reply)
    },
    onRequestTabClose: (
      callback: (data: { requestId: string; tabId: string | null; worktreeId?: string }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { requestId: string; tabId: string | null; worktreeId?: string }
      ) => callback(data)
      ipcRenderer.on('browser:requestTabClose', listener)
      return () => ipcRenderer.removeListener('browser:requestTabClose', listener)
    },
    replyTabClose: (reply: { requestId: string; error?: string }): void => {
      ipcRenderer.send('browser:tabCloseReply', reply)
    },
    onNewTerminalTab: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:newTerminalTab', listener)
      return () => ipcRenderer.removeListener('ui:newTerminalTab', listener)
    },
    onFocusBrowserAddressBar: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:focusBrowserAddressBar', listener)
      return () => ipcRenderer.removeListener('ui:focusBrowserAddressBar', listener)
    },
    onFindInBrowserPage: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:findInBrowserPage', listener)
      return () => ipcRenderer.removeListener('ui:findInBrowserPage', listener)
    },
    onReloadBrowserPage: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:reloadBrowserPage', listener)
      return () => ipcRenderer.removeListener('ui:reloadBrowserPage', listener)
    },
    onHardReloadBrowserPage: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:hardReloadBrowserPage', listener)
      return () => ipcRenderer.removeListener('ui:hardReloadBrowserPage', listener)
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
    onSwitchTabAcrossAllTypes: (callback: (direction: 1 | -1) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, direction: 1 | -1) => callback(direction)
      ipcRenderer.on('ui:switchTabAcrossAllTypes', listener)
      return () => ipcRenderer.removeListener('ui:switchTabAcrossAllTypes', listener)
    },
    onSwitchTerminalTab: (callback: (direction: 1 | -1) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, direction: 1 | -1) => callback(direction)
      ipcRenderer.on('ui:switchTerminalTab', listener)
      return () => ipcRenderer.removeListener('ui:switchTerminalTab', listener)
    },
    onToggleStatusBar: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:toggleStatusBar', listener)
      return () => ipcRenderer.removeListener('ui:toggleStatusBar', listener)
    },
    onExportPdfRequested: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('export:requestPdf', listener)
      return () => ipcRenderer.removeListener('export:requestPdf', listener)
    },
    onActivateWorktree: (
      callback: (data: {
        repoId: string
        worktreeId: string
        setup?: { runnerScriptPath: string; envVars: Record<string, string> }
        startup?: { command: string; env?: Record<string, string> }
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          repoId: string
          worktreeId: string
          setup?: { runnerScriptPath: string; envVars: Record<string, string> }
          startup?: { command: string; env?: Record<string, string> }
        }
      ) => callback(data)
      ipcRenderer.on('ui:activateWorktree', listener)
      return () => ipcRenderer.removeListener('ui:activateWorktree', listener)
    },
    onCreateTerminal: (
      callback: (data: { worktreeId: string; command?: string; title?: string }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { worktreeId: string; command?: string; title?: string }
      ) => callback(data)
      ipcRenderer.on('ui:createTerminal', listener)
      return () => ipcRenderer.removeListener('ui:createTerminal', listener)
    },
    onRequestTerminalCreate: (
      callback: (data: {
        requestId: string
        worktreeId?: string
        command?: string
        title?: string
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { requestId: string; worktreeId?: string; command?: string; title?: string }
      ) => callback(data)
      ipcRenderer.on('terminal:requestTabCreate', listener)
      return () => ipcRenderer.removeListener('terminal:requestTabCreate', listener)
    },
    replyTerminalCreate: (reply: {
      requestId: string
      tabId?: string
      title?: string
      error?: string
    }): void => {
      ipcRenderer.send('terminal:tabCreateReply', reply)
    },
    onSplitTerminal: (
      callback: (data: {
        tabId: string
        paneRuntimeId: number
        direction: 'horizontal' | 'vertical'
        command?: string
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          tabId: string
          paneRuntimeId: number
          direction: 'horizontal' | 'vertical'
          command?: string
        }
      ) => callback(data)
      ipcRenderer.on('ui:splitTerminal', listener)
      return () => ipcRenderer.removeListener('ui:splitTerminal', listener)
    },
    onRenameTerminal: (
      callback: (data: { tabId: string; title: string | null }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { tabId: string; title: string | null }
      ) => callback(data)
      ipcRenderer.on('ui:renameTerminal', listener)
      return () => ipcRenderer.removeListener('ui:renameTerminal', listener)
    },
    onFocusTerminal: (
      callback: (data: { tabId: string; worktreeId: string }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { tabId: string; worktreeId: string }
      ) => callback(data)
      ipcRenderer.on('ui:focusTerminal', listener)
      return () => ipcRenderer.removeListener('ui:focusTerminal', listener)
    },
    onCloseTerminal: (
      callback: (data: { tabId: string; paneRuntimeId?: number }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { tabId: string; paneRuntimeId?: number }
      ) => callback(data)
      ipcRenderer.on('ui:closeTerminal', listener)
      return () => ipcRenderer.removeListener('ui:closeTerminal', listener)
    },
    onSleepWorktree: (callback: (data: { worktreeId: string }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { worktreeId: string }) =>
        callback(data)
      ipcRenderer.on('ui:sleepWorktree', listener)
      return () => ipcRenderer.removeListener('ui:sleepWorktree', listener)
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
      callback: (
        data:
          | { paths: string[]; target: 'editor' }
          | { paths: string[]; target: 'terminal' }
          | { paths: string[]; target: 'composer' }
          | { paths: string[]; target: 'file-explorer'; destinationDir: string }
      ) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data:
          | { paths: string[]; target: 'editor' }
          | { paths: string[]; target: 'terminal' }
          | { paths: string[]; target: 'composer' }
          | { paths: string[]; target: 'file-explorer'; destinationDir: string }
      ) => callback(data)
      ipcRenderer.on('terminal:file-drop', listener)
      return () => ipcRenderer.removeListener('terminal:file-drop', listener)
    },
    getZoomLevel: (): number => webFrame.getZoomLevel(),
    setZoomLevel: (level: number): void => webFrame.setZoomLevel(level),
    syncTrafficLights: (zoomFactor: number): void =>
      ipcRenderer.send('ui:sync-traffic-lights', zoomFactor),
    // Why: one-way send (not invoke) so the main-process before-input-event
    // handler can read the mirrored flag synchronously without a round-trip.
    // The carve-out in createMainWindow.ts uses this to skip Cmd+B interception
    // while the markdown editor owns focus, letting TipTap apply bold instead.
    setMarkdownEditorFocused: (focused: boolean): void => {
      ipcRenderer.send('ui:setMarkdownEditorFocused', focused)
    },
    onRichMarkdownContextCommand: (
      callback: (payload: RichMarkdownContextMenuCommandPayload) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: RichMarkdownContextMenuCommandPayload
      ) => callback(payload)
      ipcRenderer.on(richMarkdownContextMenuCommandChannel, listener)
      return () => ipcRenderer.removeListener(richMarkdownContextMenuCommandChannel, listener)
    },
    onFullscreenChanged: (callback: (isFullScreen: boolean) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, isFullScreen: boolean) =>
        callback(isFullScreen)
      ipcRenderer.on('window:fullscreen-changed', listener)
      return () => ipcRenderer.removeListener('window:fullscreen-changed', listener)
    },
    /** Windows only: minimize the window via the renderer-drawn title bar. */
    minimize: (): void => {
      ipcRenderer.send('window:minimize')
    },
    /** Windows only: toggle maximize/restore via the renderer-drawn title bar. */
    maximize: (): void => {
      ipcRenderer.send('window:maximize')
    },
    /** Windows only: read the current maximize state on mount, since
     *  window:maximize-changed only fires on transitions and a window that
     *  starts maximized would otherwise show the wrong icon. */
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:isMaximized'),
    /** Windows only: subscribe to maximize state changes so the renderer-drawn
     *  maximize button can show the correct restore/maximize icon. */
    onMaximizeChanged: (callback: (isMaximized: boolean) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, isMaximized: boolean) =>
        callback(isMaximized)
      ipcRenderer.on('window:maximize-changed', listener)
      return () => ipcRenderer.removeListener('window:maximize-changed', listener)
    },
    /** Windows only: request a close from the renderer-drawn close button.
     *  Routes through main so the BrowserWindow 'close' event fires and the
     *  terminal-running confirmation guard in the renderer stays active.
     *  window.close() is unreliable in sandboxed renderers. */
    requestClose: (): void => {
      ipcRenderer.send('window:request-close')
    },
    /** Windows only: pop up the application menu at the cursor position.
     *  Replicates the Alt-key reveal that autoHideMenuBar normally provides,
     *  triggered by the ··· button in the renderer-drawn title bar. */
    popupMenu: (): void => {
      ipcRenderer.send('menu:popup')
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

  memory: {
    getSnapshot: (): Promise<MemorySnapshot> => ipcRenderer.invoke('memory:getSnapshot')
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
    getStatus: (): Promise<RuntimeStatus> => ipcRenderer.invoke('runtime:getStatus'),
    getTerminalFitOverrides: (): Promise<
      { ptyId: string; mode: 'mobile-fit'; cols: number; rows: number }[]
    > => ipcRenderer.invoke('runtime:getTerminalFitOverrides'),
    restoreTerminalFit: (ptyId: string): Promise<{ restored: boolean }> =>
      ipcRenderer.invoke('runtime:restoreTerminalFit', { ptyId }),
    onTerminalFitOverrideChanged: (
      callback: (event: {
        ptyId: string
        mode: 'mobile-fit' | 'desktop-fit'
        cols: number
        rows: number
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { ptyId: string; mode: 'mobile-fit' | 'desktop-fit'; cols: number; rows: number }
      ) => callback(data)
      ipcRenderer.on('runtime:terminalFitOverrideChanged', listener)
      return () => ipcRenderer.removeListener('runtime:terminalFitOverrideChanged', listener)
    },
    onTerminalDriverChanged: (
      callback: (event: {
        ptyId: string
        driver: { kind: 'idle' } | { kind: 'desktop' } | { kind: 'mobile'; clientId: string }
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          ptyId: string
          driver: { kind: 'idle' } | { kind: 'desktop' } | { kind: 'mobile'; clientId: string }
        }
      ) => callback(data)
      ipcRenderer.on('runtime:terminalDriverChanged', listener)
      return () => ipcRenderer.removeListener('runtime:terminalDriverChanged', listener)
    }
  },

  rateLimits: {
    get: (): Promise<RateLimitState> => ipcRenderer.invoke('rateLimits:get'),
    refresh: (): Promise<RateLimitState> => ipcRenderer.invoke('rateLimits:refresh'),
    setPollingInterval: (ms: number): Promise<void> =>
      ipcRenderer.invoke('rateLimits:setPollingInterval', ms),
    fetchInactiveClaudeAccounts: (): Promise<void> =>
      ipcRenderer.invoke('rateLimits:fetchInactiveClaudeAccounts'),
    fetchInactiveCodexAccounts: (): Promise<void> =>
      ipcRenderer.invoke('rateLimits:fetchInactiveCodexAccounts'),
    onUpdate: (callback: (state: RateLimitState) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: RateLimitState) => callback(state)
      ipcRenderer.on('rateLimits:update', listener)
      return () => ipcRenderer.removeListener('rateLimits:update', listener)
    }
  },

  ssh: {
    listTargets: (): Promise<SshTarget[]> => ipcRenderer.invoke('ssh:listTargets'),

    addTarget: (args: { target: Omit<SshTarget, 'id'> }): Promise<SshTarget> =>
      ipcRenderer.invoke('ssh:addTarget', args),

    updateTarget: (args: {
      id: string
      updates: Partial<Omit<SshTarget, 'id'>>
    }): Promise<SshTarget> => ipcRenderer.invoke('ssh:updateTarget', args),

    removeTarget: (args: { id: string }): Promise<void> =>
      ipcRenderer.invoke('ssh:removeTarget', args),

    importConfig: (): Promise<SshTarget[]> => ipcRenderer.invoke('ssh:importConfig'),

    connect: (args: { targetId: string }): Promise<SshConnectionState | null> =>
      ipcRenderer.invoke('ssh:connect', args),

    disconnect: (args: { targetId: string }): Promise<void> =>
      ipcRenderer.invoke('ssh:disconnect', args),

    getState: (args: { targetId: string }): Promise<SshConnectionState | null> =>
      ipcRenderer.invoke('ssh:getState', args),

    needsPassphrasePrompt: (args: { targetId: string }): Promise<boolean> =>
      ipcRenderer.invoke('ssh:needsPassphrasePrompt', args),

    testConnection: (args: {
      targetId: string
    }): Promise<{ success: boolean; error?: string; state?: SshConnectionState }> =>
      ipcRenderer.invoke('ssh:testConnection', args),

    onStateChanged: (
      callback: (data: { targetId: string; state: SshConnectionState }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { targetId: string; state: SshConnectionState }
      ) => callback(data)
      ipcRenderer.on('ssh:state-changed', listener)
      return () => ipcRenderer.removeListener('ssh:state-changed', listener)
    },

    addPortForward: (args: {
      targetId: string
      localPort: number
      remoteHost: string
      remotePort: number
      label?: string
    }): Promise<PortForwardEntry> => ipcRenderer.invoke('ssh:addPortForward', args),

    updatePortForward: (args: {
      id: string
      targetId: string
      localPort: number
      remoteHost: string
      remotePort: number
      label?: string
    }): Promise<PortForwardEntry> => ipcRenderer.invoke('ssh:updatePortForward', args),

    removePortForward: (args: { id: string }): Promise<PortForwardEntry | null> =>
      ipcRenderer.invoke('ssh:removePortForward', args),

    listPortForwards: (args?: { targetId?: string }): Promise<PortForwardEntry[]> =>
      ipcRenderer.invoke('ssh:listPortForwards', args),

    listDetectedPorts: (args: { targetId: string }): Promise<DetectedPort[]> =>
      ipcRenderer.invoke('ssh:listDetectedPorts', args),

    onPortForwardsChanged: (
      callback: (data: { targetId: string; forwards: PortForwardEntry[] }) => void
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: { targetId: string; forwards: PortForwardEntry[] }
      ) => callback(data)
      ipcRenderer.on('ssh:port-forwards-changed', handler)
      return () => ipcRenderer.removeListener('ssh:port-forwards-changed', handler)
    },

    onDetectedPortsChanged: (
      callback: (data: { targetId: string; ports: DetectedPort[] }) => void
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: { targetId: string; ports: DetectedPort[] }
      ) => callback(data)
      ipcRenderer.on('ssh:detected-ports-changed', handler)
      return () => ipcRenderer.removeListener('ssh:detected-ports-changed', handler)
    },

    browseDir: (args: {
      targetId: string
      dirPath: string
    }): Promise<{
      entries: { name: string; isDirectory: boolean }[]
      resolvedPath: string
    }> => ipcRenderer.invoke('ssh:browseDir', args),

    onCredentialRequest: (
      callback: (data: {
        requestId: string
        targetId: string
        kind: 'passphrase' | 'password'
        detail: string
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          requestId: string
          targetId: string
          kind: 'passphrase' | 'password'
          detail: string
        }
      ) => callback(data)
      ipcRenderer.on('ssh:credential-request', listener)
      return () => ipcRenderer.removeListener('ssh:credential-request', listener)
    },

    onCredentialResolved: (callback: (data: { requestId: string }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { requestId: string }) =>
        callback(data)
      ipcRenderer.on('ssh:credential-resolved', listener)
      return () => ipcRenderer.removeListener('ssh:credential-resolved', listener)
    },

    submitCredential: (args: { requestId: string; value: string | null }): Promise<void> =>
      ipcRenderer.invoke('ssh:submitCredential', args)
  },
  e2e: {
    getConfig: () => preloadE2EConfig
  },

  mobile: {
    listNetworkInterfaces: (): Promise<{
      interfaces: { name: string; address: string }[]
    }> => ipcRenderer.invoke('mobile:listNetworkInterfaces'),

    getPairingQR: (args?: {
      address?: string
      rotate?: boolean
    }): Promise<
      | { available: false }
      | {
          available: true
          qrDataUrl: string
          pairingUrl: string
          endpoint: string
          deviceId: string
        }
    > => ipcRenderer.invoke('mobile:getPairingQR', args),

    listDevices: (): Promise<{
      devices: { deviceId: string; name: string; pairedAt: number; lastSeenAt: number }[]
    }> => ipcRenderer.invoke('mobile:listDevices'),

    revokeDevice: (args: { deviceId: string }): Promise<{ revoked: boolean }> =>
      ipcRenderer.invoke('mobile:revokeDevice', args),

    isWebSocketReady: (): Promise<{ ready: boolean; endpoint: string | null }> =>
      ipcRenderer.invoke('mobile:isWebSocketReady')
  },

  agentStatus: {
    /** Listen for agent status updates forwarded from native hook receivers. */
    onSet: (
      callback: (data: {
        paneKey: string
        tabId?: string
        worktreeId?: string
        state: AgentStatusState
        prompt?: string
        agentType?: string
        toolName?: string
        toolInput?: string
        lastAssistantMessage?: string
        interrupted?: boolean
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          paneKey: string
          tabId?: string
          worktreeId?: string
          state: AgentStatusState
          prompt?: string
          agentType?: string
          toolName?: string
          toolInput?: string
          lastAssistantMessage?: string
          interrupted?: boolean
        }
      ) => callback(data)
      ipcRenderer.on('agentStatus:set', listener)
      return () => ipcRenderer.removeListener('agentStatus:set', listener)
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
