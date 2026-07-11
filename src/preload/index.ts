/* eslint-disable max-lines -- Why: the preload bridge is the audited contract between
renderer and Electron. Keeping the IPC surface co-located in one file makes security
review and type drift checks easier than scattering these bindings across modules. */
import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { preloadE2EConfig } from './e2e-config'
import { glApi } from './gitlab'
import type { AppIdentity } from '../shared/app-identity'
import type { CliInstallStatus } from '../shared/cli-install-types'
import type { AgentHookInstallStatus } from '../shared/agent-hook-types'
import type { TerminalPaneSplitSource } from '../shared/feature-education-telemetry'
import type { ProjectExecutionRuntimeResolution } from '../shared/project-execution-runtime'
import type { StartupCommandDelivery } from '../shared/codex-startup-delivery'
import type { SleepingAgentLaunchConfig } from '../shared/agent-session-resume'
import type {
  BaseRefSearchResult,
  BaseRefDefaultResult,
  BrowserViewportOverride,
  CustomPet,
  FsChangedPayload,
  GetRateLimitResult,
  GitHubPRRefreshCandidate,
  GitHubPRRefreshEvent,
  GitHubPRRefreshReason,
  GitHubAssignableUser,
  GitHubCommentResult,
  GitHubCreateIssueResult,
  GitHubWorkItem,
  JiraProjectStatusOrder,
  GitPushTarget,
  GitStagingArea,
  GitForkSyncExpectedUpstream,
  GitForkSyncResult,
  GitUpstreamStatus,
  GhosttyImportPreview,
  ListWorkItemsResult,
  LinearProjectDetail,
  MemorySnapshot,
  NotificationDismissResult,
  NotificationDispatchResult,
  NotificationDeliveryProbeResult,
  NotificationPermissionStatusResult,
  NotificationSoundDataResult,
  NotificationSoundPathResult,
  NotificationSoundResult,
  NestedRepoScanResult,
  OnboardingState,
  PersistedUIState,
  FloatingTerminalCwdRequest,
  MarkdownDocument,
  SearchResult,
  TuiAgent,
  UpdateStatus,
  WorktreeBaseStatusEvent,
  WorktreeDefaultTabsLaunch,
  WorktreeRemoteBranchConflictEvent
} from '../shared/types'
import type { PtyModelRestoreNeededEvent } from '../shared/pty-model-restore-marker'
import type {
  PtyRendererDeliveryHealthReply,
  PtyRendererDeliveryStateReport
} from '../shared/pty-renderer-delivery-health'
import type { TerminalViewAttributes } from '../shared/terminal-view-attributes'
import type { PtyMainDeliveryDiagnostics } from '../shared/pty-delivery-diagnostics'
import type {
  WarpThemeImportPreview,
  WarpThemeImportSource
} from '../shared/terminal-custom-themes'
import type { GitHistoryOptions, GitHistoryResult } from '../shared/git-history'
import type { ShellOpenLocalPathResult } from '../shared/shell-open-types'
import type { SkillDiscoveryResult, SkillDiscoveryTarget } from '../shared/skills'
import type {
  RuntimeBrowserDriverState,
  RuntimeMobileSessionTabMove,
  RuntimeStatus,
  RuntimeSyncWindowGraphResult,
  RuntimeSyncWindowGraph,
  RuntimeTerminalCreateRequestPayload,
  RuntimeTerminalDriverState,
  RuntimeTerminalPresentation
} from '../shared/runtime-types'
import type { RuntimeRpcResponse } from '../shared/runtime-rpc-envelope'
import type { PublicKnownRuntimeEnvironment } from '../shared/runtime-environments'
import type { RemoteWorkspaceChangedEvent } from '../shared/remote-workspace-types'
import type {
  RuntimeMobileMarkdownRequest,
  RuntimeMobileMarkdownResponse
} from '../shared/mobile-markdown-document'
import type {
  CodexRateLimitResetResult,
  GrokAccountStatus,
  RateLimitRuntimeTarget,
  RateLimitState
} from '../shared/rate-limit-types'
import type { WorkspaceSpaceScanProgress } from '../shared/workspace-space-types'
import type { WorkspaceCleanupScanProgress } from '../shared/workspace-cleanup'
import type { WorkspacePortAdvertisedUrlChangedEvent } from '../shared/workspace-ports'
import type { GhAuthDiagnostic } from '../shared/github-auth-types'
import type { TaskSourceContext } from '../shared/task-source-context'
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
  EnrichedDetectedPort
} from '../shared/ssh-types'
import type {
  AgentStatusIpcPayload,
  MigrationUnsupportedPtyEntry
} from '../shared/agent-status-types'
import type { AgentInterruptInferenceRequest } from '../shared/agent-interrupt-intent'
import type { TerminalSideEffectBatch } from '../shared/terminal-side-effect-facts'
import type {
  SpeechErrorEvent,
  SpeechLifecycleEvent,
  SpeechModelManifest,
  SpeechModelState,
  SpeechTranscriptEvent
} from '../shared/speech-types'
import type { TelemetryConsentState } from '../shared/telemetry-consent-types'
import type { PreflightRuntimeContext, RefreshAgentsResult } from './api-types'
import type { AgentKind, LaunchSource, RequestKind } from '../shared/telemetry-events'
import type { AppStarSource } from '../shared/gh-star-source'
import type { ExecutionHostId } from '../shared/execution-host'
import type {
  Automation,
  AutomationCreateInput,
  AutomationDispatchRequest,
  AutomationDispatchResult,
  ExternalAutomationCreateInput,
  ExternalAutomationActionInput,
  ExternalAutomationManager,
  ExternalAutomationRunsInput,
  ExternalAutomationRunsPage,
  ExternalAutomationUpdateInput,
  AutomationRun,
  AutomationPrecheckResult,
  AutomationUpdateInput
} from '../shared/automations-types'
import type { KeybindingActionId, KeybindingFileSnapshot } from '../shared/keybindings'
import type { AiVaultListArgs, AiVaultSubagentListArgs } from '../shared/ai-vault-types'
import type { AgentType } from '../shared/native-chat-types'
import type {
  NativeChatAppendedMessages,
  NativeChatAppendedPayload,
  NativeChatReadSessionResult
} from './api-types'
import {
  ORCA_EDITOR_PREPARE_HOT_EXIT_EVENT,
  type EditorPrepareHotExitDetail
} from '../shared/editor-save-events'
import {
  ORCA_APP_RESTART_ABORTED_EVENT,
  ORCA_APP_RESTART_STARTED_EVENT,
  ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT,
  ORCA_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT
} from '../shared/updater-renderer-events'
import {
  ORCA_INTERNAL_FILE_DRAG_TYPE,
  createNativeFileDropPayload,
  createRejectedNativeFileDropPayload,
  hasNativeFileDragTypes,
  NATIVE_FILE_DROP_MAX_PATHS,
  resolveNativeFileDropPath,
  type NativeDropResolution,
  type NativeFileDropPayload,
  type NativeFileDropPathEntry
} from '../shared/native-file-drop'
import type {
  LocalLogTailChangedPayload,
  LocalLogTailReadArgs,
  LocalLogTailReadResult,
  LocalLogTailWatchArgs
} from '../shared/local-log-tail-types'
import { subscribeRuntimeEnvironmentFromPreload } from './runtime-environment-subscriptions'
import type { RuntimeEnvironmentSubscriptionHandle } from './runtime-environment-subscriptions'
import type { HostedReviewForBranchArgs } from '../shared/hosted-review'
import type { ReadClipboardTextOptions } from '../shared/clipboard-text'
import type {
  LocalhostWorktreeLabelResult,
  LocalhostWorktreeLabelRoute
} from '../shared/localhost-worktree-labels'
import type {
  CrashReportBreadcrumbData,
  CrashReportSubmitArgs,
  CrashReportSubmitResult,
  ReactErrorBoundaryReportArgs,
  ReactErrorBoundaryReportResult
} from '../shared/crash-reporting'
import type { PreloadApi } from './api-types'

type NativeFileDropCallback = (data: NativeFileDropPayload) => void

const nativeFileDropCallbacks: NativeFileDropCallback[] = []
let nativeFileDropListenerRegistered = false

function getLinuxDisplayServer(): 'wayland' | 'x11' | null {
  if (process.platform !== 'linux') {
    return null
  }
  if (
    process.env.WAYLAND_DISPLAY ||
    process.env.XDG_SESSION_TYPE?.toLowerCase() === 'wayland' ||
    process.env.ELECTRON_OZONE_PLATFORM_HINT?.toLowerCase() === 'wayland'
  ) {
    return 'wayland'
  }
  return process.env.DISPLAY ? 'x11' : null
}

type AppRestartPrepOptions = {
  startedEventName: string
  abortedEventName: string
}

function requestEditorHotExitBackup(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let claimed = false
    window.dispatchEvent(
      new CustomEvent<EditorPrepareHotExitDetail>(ORCA_EDITOR_PREPARE_HOT_EXIT_EVENT, {
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

    // Why: restart paths can run before the editor autosave controller mounts.
    // With no claimant, there are no renderer-owned dirty buffers to back up.
    if (!claimed) {
      resolve()
    }
  })
}

async function prepareRendererForAppRestart({
  startedEventName,
  abortedEventName
}: AppRestartPrepOptions): Promise<void> {
  window.dispatchEvent(new Event(startedEventName))

  try {
    await requestEditorHotExitBackup()
  } catch (error) {
    window.dispatchEvent(new Event(abortedEventName))
    throw error
  }

  // Dispatch beforeunload now so terminal buffers are captured while panes are
  // still mounted; update installs later bypass the ordinary close sequence.
  window.dispatchEvent(new Event('beforeunload'))
}

const onNativeFileDrop = (_event: Electron.IpcRendererEvent, data: NativeFileDropPayload): void => {
  for (const callback of Array.from(nativeFileDropCallbacks)) {
    callback(data)
  }
}

function subscribeNativeFileDrop(callback: NativeFileDropCallback): () => void {
  nativeFileDropCallbacks.push(callback)
  if (!nativeFileDropListenerRegistered) {
    // Why: terminal panes subscribe per visible split group, so the IPC layer
    // must keep one real listener and fan out locally to avoid listener warnings.
    ipcRenderer.on('terminal:file-drop', onNativeFileDrop)
    nativeFileDropListenerRegistered = true
  }
  return () => {
    const callbackIndex = nativeFileDropCallbacks.indexOf(callback)
    if (callbackIndex !== -1) {
      nativeFileDropCallbacks.splice(callbackIndex, 1)
    }
    if (nativeFileDropCallbacks.length === 0 && nativeFileDropListenerRegistered) {
      ipcRenderer.removeListener('terminal:file-drop', onNativeFileDrop)
      nativeFileDropListenerRegistered = false
    }
  }
}

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
// Why: audio.play() can reject before ended/error fires; keep a cleanup hook
// so failed or replaced plays do not accumulate listeners on the cached Audio.
let cleanupNotificationSoundPlayback: (() => void) | null = null

function clearNotificationSoundPlaybackState(): void {
  cleanupNotificationSoundPlayback?.()
  cleanupNotificationSoundPlayback = null
  isNotificationSoundPlaying = false
}

function disposeCachedNotificationSound(): void {
  if (cachedNotificationSound) {
    clearNotificationSoundPlaybackState()
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
  const pathEntries: NativeFileDropPathEntry[] = []
  for (const entry of event.composedPath()) {
    if (entry instanceof HTMLElement) {
      pathEntries.push({
        nativeFileDropTarget: entry.dataset.nativeFileDropTarget,
        nativeFileDropDir: entry.dataset.nativeFileDropDir,
        terminalTabId: entry.dataset.terminalTabId,
        terminalPaneLeafId: entry.dataset.terminalPaneLeafId ?? entry.dataset.leafId
      })
    }
  }
  return resolveNativeFileDropPath(pathEntries)
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
    if (e.dataTransfer && !hasNativeFileDragTypes(e.dataTransfer.types)) {
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
    if (e.dataTransfer?.types.includes(ORCA_INTERNAL_FILE_DRAG_TYPE)) {
      return
    }

    e.preventDefault()
    e.stopPropagation()
    const files = e.dataTransfer?.files
    if (!files || files.length === 0) {
      return
    }
    const resolution = resolveNativeFileDrop(e)

    // Why: resolving native File objects to paths is synchronous in preload.
    // Reject oversized gestures by count before touching every File object.
    if (files.length > NATIVE_FILE_DROP_MAX_PATHS) {
      ipcRenderer.send(
        'terminal:file-dropped-from-preload',
        createRejectedNativeFileDropPayload({
          byteLength: 0,
          pathCount: files.length,
          reason: 'too-many-paths',
          status: 'rejected'
        })
      )
      return
    }

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

    const payload = createNativeFileDropPayload(resolution, paths)
    if (!payload) {
      return
    }
    // Why: preload must emit exactly one native-drop event per drop gesture.
    // The shared planner also rejects large path payloads without including
    // path contents in the failure event.
    ipcRenderer.send('terminal:file-dropped-from-preload', payload)
  },
  true
)

const startupDiagnosticsEnabled = process.env.ORCA_STARTUP_DIAGNOSTICS === '1'

// Custom APIs for renderer
const api = {
  app: {
    getIdentity: (): Promise<AppIdentity> => ipcRenderer.invoke('app:getIdentity'),
    getFeatureWallAssetBaseUrl: (): Promise<string> =>
      ipcRenderer.invoke('app:getFeatureWallAssetBaseUrl'),
    relaunch: (): Promise<void> => ipcRenderer.invoke('app:relaunch'),
    restart: async (): Promise<void> => {
      await prepareRendererForAppRestart({
        startedEventName: ORCA_APP_RESTART_STARTED_EVENT,
        abortedEventName: ORCA_APP_RESTART_ABORTED_EVENT
      })
      try {
        return await ipcRenderer.invoke('app:restart')
      } catch (error) {
        window.dispatchEvent(new Event(ORCA_APP_RESTART_ABORTED_EVENT))
        throw error
      }
    },
    reload: (): Promise<void> => ipcRenderer.invoke('app:reload'),
    awaitFirstWindowStartupServices: (): Promise<void> =>
      ipcRenderer.invoke('app:awaitFirstWindowStartupServices'),
    startupDiagnostic: (event: string, details?: Record<string, unknown>): Promise<void> =>
      startupDiagnosticsEnabled
        ? ipcRenderer.invoke('app:startupDiagnostic', event, details)
        : Promise.resolve(),
    // Why: on macOS this returns the active input mode, or the layout ID when
    // no IME mode is selected, so renderer keyboard workarounds can distinguish
    // CJK IMEs and compose layouts from plain US QWERTY (see issue #1205).
    // Returns null on non-Darwin or when the defaults read fails.
    getKeyboardInputSourceId: (): Promise<string | null> =>
      ipcRenderer.invoke('app:getKeyboardInputSourceId'),
    setUnreadDockBadgeCount: (count: number): Promise<void> =>
      ipcRenderer.invoke('app:setUnreadDockBadgeCount', count),
    getFloatingTerminalCwd: (args?: FloatingTerminalCwdRequest): Promise<string> =>
      ipcRenderer.invoke('app:getFloatingTerminalCwd', args),
    getFloatingMarkdownDirectory: (): Promise<string> =>
      ipcRenderer.invoke('app:getFloatingMarkdownDirectory'),
    pickFloatingMarkdownDocument: (): Promise<MarkdownDocument | null> =>
      ipcRenderer.invoke('app:pickFloatingMarkdownDocument'),
    pickFloatingWorkspaceDirectory: (): Promise<string | null> =>
      ipcRenderer.invoke('app:pickFloatingWorkspaceDirectory')
  },

  orcaProfiles: {
    list: () => ipcRenderer.invoke('orcaProfiles:list'),
    authStatus: () => ipcRenderer.invoke('orcaProfiles:authStatus'),
    createLocal: (args) => ipcRenderer.invoke('orcaProfiles:createLocal', args),
    createCloudLinked: (args) => ipcRenderer.invoke('orcaProfiles:createCloudLinked', args),
    switchProfile: (args) => ipcRenderer.invoke('orcaProfiles:switch', args),
    transferProject: (args) => ipcRenderer.invoke('orcaProfiles:transferProject', args),
    findProjectProfiles: (args) => ipcRenderer.invoke('orcaProfiles:findProjectProfiles', args),
    connectCurrent: () => ipcRenderer.invoke('orcaProfiles:connectCurrent'),
    refreshAuth: () => ipcRenderer.invoke('orcaProfiles:refreshAuth'),
    signOutCurrent: () => ipcRenderer.invoke('orcaProfiles:signOutCurrent'),
    selectOrg: (args) => ipcRenderer.invoke('orcaProfiles:selectOrg', args),
    orgMembersList: (args) => ipcRenderer.invoke('orcaProfiles:orgMembersList', args),
    orgMemberInvite: (args) => ipcRenderer.invoke('orcaProfiles:orgMemberInvite', args),
    orgInviteRevoke: (args) => ipcRenderer.invoke('orcaProfiles:orgInviteRevoke', args),
    orgMemberChangeRole: (args) => ipcRenderer.invoke('orcaProfiles:orgMemberChangeRole', args),
    orgMemberRemove: (args) => ipcRenderer.invoke('orcaProfiles:orgMemberRemove', args)
  } satisfies PreloadApi['orcaProfiles'],

  platform: {
    get: () => ({
      platform: process.platform,
      osRelease:
        (process as NodeJS.Process & { getSystemVersion?: () => string }).getSystemVersion?.() ??
        '',
      displayServer: getLinuxDisplayServer()
    })
  } satisfies PreloadApi['platform'],

  wsl: {
    isAvailable: (): Promise<boolean> => ipcRenderer.invoke('wsl:isAvailable'),
    listDistros: (): Promise<string[]> => ipcRenderer.invoke('wsl:listDistros')
  },

  pwsh: {
    isAvailable: (): Promise<boolean> => ipcRenderer.invoke('pwsh:isAvailable')
  },

  gitBash: {
    isAvailable: (): Promise<boolean> => ipcRenderer.invoke('gitBash:isAvailable')
  },

  repos: {
    list: () => ipcRenderer.invoke('repos:list'),

    add: (args) => ipcRenderer.invoke('repos:add', args),

    addRemote: (args) => ipcRenderer.invoke('repos:addRemote', args),

    create: (args) => ipcRenderer.invoke('repos:create', args),

    isGitAvailable: (): Promise<boolean> => ipcRenderer.invoke('repos:isGitAvailable'),

    getDefaultCreateProjectParent: (): Promise<string> =>
      ipcRenderer.invoke('repos:getDefaultCreateProjectParent'),

    remove: (args) => ipcRenderer.invoke('repos:remove', args),

    removeForHost: (args) => ipcRenderer.invoke('repos:removeForHost', args),

    reorder: (args) => ipcRenderer.invoke('repos:reorder', args),

    update: (args) => ipcRenderer.invoke('repos:update', args),

    pickFolder: () => ipcRenderer.invoke('repos:pickFolder'),

    pickFolders: () => ipcRenderer.invoke('repos:pickFolders'),

    pickDirectory: () => ipcRenderer.invoke('repos:pickDirectory'),

    clone: (args) => ipcRenderer.invoke('repos:clone', args),

    cloneRemote: (args) => ipcRenderer.invoke('repos:cloneRemote', args),

    createRemote: (args) => ipcRenderer.invoke('repos:createRemote', args),

    cloneAbort: () => ipcRenderer.invoke('repos:cloneAbort'),

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

    searchBaseRefDetails: (args: {
      repoId: string
      query: string
      limit?: number
    }): Promise<BaseRefSearchResult[]> => ipcRenderer.invoke('repos:searchBaseRefDetails', args),

    onChanged: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('repos:changed', listener)
      return () => ipcRenderer.removeListener('repos:changed', listener)
    }
  } satisfies PreloadApi['repos'],

  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    update: (args) => ipcRenderer.invoke('projects:update', args),
    listHostSetups: () => ipcRenderer.invoke('projectHostSetups:list'),
    createHostSetup: (args) => ipcRenderer.invoke('projectHostSetups:create', args),
    setupExistingFolder: (args) =>
      ipcRenderer.invoke('projectHostSetups:setupExistingFolder', args),
    updateHostSetup: (args) => ipcRenderer.invoke('projectHostSetups:update', args),
    deleteHostSetup: (args) => ipcRenderer.invoke('projectHostSetups:delete', args)
  } satisfies PreloadApi['projects'],

  projectGroups: {
    list: () => ipcRenderer.invoke('projectGroups:list'),
    create: (args) => ipcRenderer.invoke('projectGroups:create', args),
    update: (args) => ipcRenderer.invoke('projectGroups:update', args),
    delete: (args) => ipcRenderer.invoke('projectGroups:delete', args),
    moveProject: (args) => ipcRenderer.invoke('projectGroups:moveProject', args),
    scanNested: (args) => ipcRenderer.invoke('projectGroups:scanNested', args),
    cancelNestedScan: (args) => ipcRenderer.invoke('projectGroups:cancelNestedScan', args),
    onNestedScanProgress: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { scanId: string; scan: NestedRepoScanResult }
      ) => callback(data)
      ipcRenderer.on('projectGroups:scanNestedProgress', listener)
      return () => ipcRenderer.removeListener('projectGroups:scanNestedProgress', listener)
    },
    importNested: (args) => ipcRenderer.invoke('projectGroups:importNested', args)
  } satisfies PreloadApi['projectGroups'],

  folderWorkspaces: {
    list: () => ipcRenderer.invoke('folderWorkspaces:list'),
    getPathStatus: (args) => ipcRenderer.invoke('folderWorkspaces:getPathStatus', args),
    create: (args) => ipcRenderer.invoke('folderWorkspaces:create', args),
    update: (args) => ipcRenderer.invoke('folderWorkspaces:update', args),
    delete: (args) => ipcRenderer.invoke('folderWorkspaces:delete', args)
  } satisfies PreloadApi['folderWorkspaces'],

  sparsePresets: {
    list: (args) => ipcRenderer.invoke('sparsePresets:list', args),

    save: (args) => ipcRenderer.invoke('sparsePresets:save', args),

    remove: (args) => ipcRenderer.invoke('sparsePresets:remove', args),

    onChanged: (callback: (data: { repoId: string }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { repoId: string }) =>
        callback(data)
      ipcRenderer.on('sparsePresets:changed', listener)
      return () => ipcRenderer.removeListener('sparsePresets:changed', listener)
    }
  } satisfies PreloadApi['sparsePresets'],

  worktrees: {
    list: (args) => ipcRenderer.invoke('worktrees:list', args),

    listDetected: (args) => ipcRenderer.invoke('worktrees:listDetected', args),

    listAll: () => ipcRenderer.invoke('worktrees:listAll'),

    create: (args) => ipcRenderer.invoke('worktrees:create', args),

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

    updateLineage: (args) => ipcRenderer.invoke('worktrees:updateLineage', args),

    persistSortOrder: (args) => ipcRenderer.invoke('worktrees:persistSortOrder', args),

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
  } satisfies PreloadApi['worktrees'],

  workspaceCleanup: {
    scan: (args, onProgress) => {
      if (!onProgress) {
        return ipcRenderer.invoke('workspaceCleanup:scan', args)
      }
      const scanId = args?.scanId ?? crypto.randomUUID()
      const listener = (
        _event: Electron.IpcRendererEvent,
        progress: WorkspaceCleanupScanProgress
      ): void => {
        if (progress.scanId === scanId) {
          onProgress(progress)
        }
      }
      ipcRenderer.on('workspaceCleanup:scanProgress', listener)
      return ipcRenderer
        .invoke('workspaceCleanup:scan', { ...args, scanId })
        .finally(() => ipcRenderer.removeListener('workspaceCleanup:scanProgress', listener))
    },
    dismiss: (args) => ipcRenderer.invoke('workspaceCleanup:dismiss', args),
    clearDismissals: () => ipcRenderer.invoke('workspaceCleanup:clearDismissals'),
    hasKillableLocalProcesses: (args) =>
      ipcRenderer.invoke('workspaceCleanup:hasKillableLocalProcesses', args)
  } satisfies PreloadApi['workspaceCleanup'],

  workspaceSpace: {
    analyze: () => ipcRenderer.invoke('workspaceSpace:analyze'),
    cancel: () => ipcRenderer.invoke('workspaceSpace:cancel'),
    onProgress: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        progress: WorkspaceSpaceScanProgress
      ): void => callback(progress)
      ipcRenderer.on('workspaceSpace:progress', listener)
      return () => ipcRenderer.removeListener('workspaceSpace:progress', listener)
    }
  } satisfies PreloadApi['workspaceSpace'],

  workspacePorts: {
    scan: (args) => ipcRenderer.invoke('workspacePorts:scan', args),
    kill: (args) => ipcRenderer.invoke('workspacePorts:kill', args),
    onAdvertisedUrlChanged: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        event: WorkspacePortAdvertisedUrlChangedEvent
      ): void => callback(event)
      ipcRenderer.on('workspacePorts:advertised-url-changed', listener)
      return () => ipcRenderer.removeListener('workspacePorts:advertised-url-changed', listener)
    }
  } satisfies PreloadApi['workspacePorts'],

  pty: {
    spawn: (opts: {
      cols: number
      rows: number
      cwd?: string
      cwdFallback?: 'worktree'
      env?: Record<string, string>
      command?: string
      launchConfig?: SleepingAgentLaunchConfig
      launchToken?: string
      launchAgent?: TuiAgent
      startupCommandDelivery?: StartupCommandDelivery
      connectionId?: string | null
      worktreeId?: string
      sessionId?: string
      shellOverride?: string
      projectRuntime?: ProjectExecutionRuntimeResolution
      terminalColorQueryReplies?: { foreground?: string; background?: string }
      // Why: hidden-at-spawn declaration — main marks the PTY hidden before
      // its first byte so the delivery gate + model responder own spawn-time
      // queries (terminal-query-authority.md §races).
      initiallyHidden?: boolean
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
      launchConfig?: SleepingAgentLaunchConfig
      snapshot?: string
      snapshotCols?: number
      snapshotRows?: number
      isReattach?: boolean
      isAlternateScreen?: boolean
      replay?: string
      sessionExpired?: boolean
      coldRestore?: { scrollback: string; cwd: string }
      startupCwdFallback?: { kind: 'worktree'; cwd: string }
    }> => ipcRenderer.invoke('pty:spawn', opts),

    write: (id: string, data: string): void => {
      ipcRenderer.send('pty:write', { id, data })
    },
    writeAccepted: (id: string, data: string): Promise<boolean> =>
      ipcRenderer.invoke('pty:writeAccepted', { id, data }),

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

    /** Why: Cmd/Ctrl+K clears the renderer xterm, but the PTY host (ConPTY,
     * daemon emulator, SSH host buffer) keeps its own screen state and would
     * repaint the next prompt at the stale cursor row. */
    clearBuffer: (id: string): void => {
      ipcRenderer.send('pty:clearBuffer', { id })
    },

    ackColdRestore: (id: string): void => {
      ipcRenderer.send('pty:ackColdRestore', { id })
    },
    /** charCount is the legacy per-chunk delta; processedChars is the
     *  cumulative per-pty total (self-healing under lost ACK messages). */
    ackData: (id: string, charCount: number, processedChars?: number): void => {
      ipcRenderer.send('pty:ackData', {
        id,
        charCount,
        ...(typeof processedChars === 'number' ? { processedChars } : {})
      })
    },
    /** Main asks for the renderer's cumulative processed totals when terminal
     *  delivery looks stuck on lost ACKs. */
    onDeliveryResyncRequest: (callback: (payload: { requestId: number }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { requestId: number }) =>
        callback(payload)
      ipcRenderer.on('pty:requestDeliveryResync', listener)
      return () => ipcRenderer.removeListener('pty:requestDeliveryResync', listener)
    },
    respondDeliveryResync: (payload: {
      requestId: number
      processedCharsByPty: Record<string, number>
    }): void => {
      ipcRenderer.send('pty:deliveryResyncResponse', payload)
    },
    /** Renderer-initiated delivery health/heal lane. Rides invoke because the
     *  field wedge (v1.4.121-rc.0 snapshot) kills main→renderer push events
     *  while invoke stays alive — push-initiated recovery can't reach it. */
    reportRendererDeliveryState: (
      report: PtyRendererDeliveryStateReport
    ): Promise<PtyRendererDeliveryHealthReply> =>
      ipcRenderer.invoke('pty:reportRendererDeliveryState', report),
    /** Sync count of live pty:data listeners on this preload's emitter — the
     *  watchdog's "listener detached" vs "channel dead" discriminator. */
    getPtyDataListenerCount: (): number => ipcRenderer.listenerCount('pty:data'),
    rendererDispatcherReady: (): void => {
      ipcRenderer.send('pty:rendererDispatcherReady')
    },
    setActiveRendererPty: (id: string, active: boolean): void => {
      ipcRenderer.send('pty:setActiveRendererPty', { id, active })
    },
    setRendererPtyVisible: (id: string, visible: boolean): void => {
      ipcRenderer.send('pty:setRendererPtyVisible', { id, visible })
    },
    /** Hidden-delivery gate (Phase 4): hidden=true lets main DROP renderer
     *  byte delivery after model ingestion; reveal restores from the model
     *  snapshot. Fire-and-forget like setActiveRendererPty. */
    setHiddenRendererPty: (id: string, hidden: boolean): void => {
      ipcRenderer.send('pty:setHiddenRendererPty', { id, hidden })
    },
    /** Delivery-interest signal: any renderer party that needs raw bytes
     *  (dispatcher sidecars, eager pre-mount buffers) suppresses the
     *  hidden-delivery gate for that PTY while registered. */
    setPtyDeliveryInterest: (id: string, interested: boolean): void => {
      ipcRenderer.send('pty:setPtyDeliveryInterest', { id, interested })
    },
    /** View-attribute bridge (Phase 5 slice 2): app-global composed terminal
     *  appearance push that lets main's model responder answer OSC 4/10/11/12
     *  and DSR ?996n for hidden-gated PTYs with renderer-true values. */
    publishTerminalViewAttributes: (attributes: TerminalViewAttributes): void => {
      ipcRenderer.send('pty:terminalViewAttributes', attributes)
    },

    kill: (id: string, opts?: { keepHistory?: boolean }): Promise<void> =>
      ipcRenderer.invoke('pty:kill', { id, keepHistory: opts?.keepHistory ?? false }),

    listSessions: (): Promise<{ id: string; cwd: string; title: string }[]> =>
      ipcRenderer.invoke('pty:listSessions'),
    hasPty: (id: string): Promise<boolean | null> => ipcRenderer.invoke('pty:hasPty', { id }),

    getMainBufferSnapshot: (
      id: string,
      opts?: { scrollbackRows?: number }
    ): Promise<{
      data: string
      cols: number
      rows: number
      cwd?: string | null
      seq?: number
      pendingDeliveryStartSeq?: number
      source?: 'headless' | 'renderer'
      alternateScreen?: boolean
      scrollbackAnsi?: string
      pendingEscapeTailAnsi?: string
    } | null> => ipcRenderer.invoke('pty:getMainBufferSnapshot', { id, opts }),

    getRendererDeliveryDebugSnapshot: (): Promise<{
      pendingPtyCount: number
      pendingChars: number
      maxPendingCharsByPty: number
      rendererInFlightPtyCount: number
      rendererInFlightChars: number
      maxRendererInFlightCharsByPty: number
      activeRendererPtyCount: number
      flushScheduled: boolean
      peakPendingChars: number
      peakMaxPendingCharsByPty: number
      peakRendererInFlightChars: number
      peakMaxRendererInFlightCharsByPty: number
      ackGatedFlushSkipCount: number
      hiddenDeliveryGatedPtyCount: number
      hiddenDeliveryGatedVisiblePtyCount: number
      hiddenDeliveryGatedActivePtyCount: number
      deliveryInterestPtyCount: number
      hiddenDeliveryDroppedChars: number
      hiddenDeliveryDroppedChunks: number
      pendingDroppedChars: number
      diagnostics: PtyMainDeliveryDiagnostics
      rendererLifecycleResetCount: number
      lastLifecycleResetClearedChars: number
      rendererPtyDispatcherReady: boolean
      rendererDispatcherReadyForcedCount: number
    }> => ipcRenderer.invoke('pty:getRendererDeliveryDebugSnapshot'),

    resetRendererDeliveryDebug: (): Promise<void> =>
      ipcRenderer.invoke('pty:resetRendererDeliveryDebug'),

    /** Check if a PTY's shell has child processes (e.g. a running command).
     *  Returns false for an idle shell prompt. */
    hasChildProcesses: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('pty:hasChildProcesses', { id }),

    /** Return the PTY foreground process basename when available (e.g. "codex"). */
    getForegroundProcess: (id: string): Promise<string | null> =>
      ipcRenderer.invoke('pty:getForegroundProcess', { id }),
    confirmForegroundProcess: (id: string): Promise<string | null> =>
      ipcRenderer.invoke('pty:confirmForegroundProcess', { id }),

    /** Resolve the live cwd of a PTY via `/proc` (Linux) or `lsof` (macOS).
     *  Returns `''` when the id is unknown or the platform cannot resolve one. */
    getCwd: (id: string): Promise<string> => ipcRenderer.invoke('pty:getCwd', { id }),

    /** The PTY's last APPLIED size (its real winsize), or null if unknown.
     *  Lets the renderer detect drift after a resize was dropped main-side and
     *  re-assert, instead of trusting the size it last fired blind. */
    getSize: (id: string): Promise<{ cols: number; rows: number } | null> =>
      ipcRenderer.invoke('pty:getSize', { id }),

    onData: (
      callback: (data: {
        id: string
        data: string
        seq?: number
        rawLength?: number
        background?: boolean
        droppedOutput?: boolean
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          id: string
          data: string
          seq?: number
          rawLength?: number
          background?: boolean
          droppedOutput?: boolean
        }
      ) => callback(data)
      ipcRenderer.on('pty:data', listener)
      return () => ipcRenderer.removeListener('pty:data', listener)
    },

    onReplay: (callback: (data: { id: string; data: string }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { id: string; data: string }) =>
        callback(data)
      ipcRenderer.on('pty:replay', listener)
      return () => ipcRenderer.removeListener('pty:replay', listener)
    },

    /** Out-of-band signal that main dropped renderer-bound bytes for a PTY
     *  (hidden-delivery gate / pending cap) — the pane must restore from the
     *  model snapshot. Deliberately NOT on pty:data: an in-band marker is
     *  ambiguous with chunks fully stripped by OSC-9999 cleaning. */
    onModelRestoreNeeded: (callback: (event: PtyModelRestoreNeededEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, event: PtyModelRestoreNeededEvent) =>
        callback(event)
      ipcRenderer.on('pty:modelRestoreNeeded', listener)
      return () => ipcRenderer.removeListener('pty:modelRestoreNeeded', listener)
    },

    /** Batched derived side-effect facts (title/bell/agent transitions) for
     *  PTYs whose bytes transit local main. Per-PTY in-order; deliberately not
     *  synchronized with pty:data (terminal-side-effect-authority.md). */
    onSideEffect: (callback: (batch: TerminalSideEffectBatch) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, batch: TerminalSideEffectBatch) =>
        callback(batch)
      ipcRenderer.on('pty:sideEffect', listener)
      return () => ipcRenderer.removeListener('pty:sideEffect', listener)
    },

    /** Title-only replay snapshot applied on (re)attach — attention facts
     *  (bells/completions) never replay. */
    getSideEffectSnapshot: (id: string): Promise<TerminalSideEffectBatch | null> =>
      ipcRenderer.invoke('pty:sideEffectSnapshot', { id }),

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

    onClearBufferRequest: (callback: (data: { ptyId: string }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { ptyId: string }) =>
        callback(data)
      ipcRenderer.on('pty:clearBuffer:request', listener)
      return () => ipcRenderer.removeListener('pty:clearBuffer:request', listener)
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

  crashReports: {
    getLatestPending: () => ipcRenderer.invoke('crashReports:getLatestPending'),
    getLatestReport: () => ipcRenderer.invoke('crashReports:getLatestReport'),
    dismiss: (args: { reportId: string }) => ipcRenderer.invoke('crashReports:dismiss', args),
    recordRendererError: (
      args: ReactErrorBoundaryReportArgs
    ): Promise<ReactErrorBoundaryReportResult> =>
      ipcRenderer.invoke('crashReports:recordRendererError', args),
    recordBreadcrumb: (args: { name: string; data?: CrashReportBreadcrumbData }): void =>
      ipcRenderer.send('crashReports:recordBreadcrumb', args),
    submit: (args: CrashReportSubmitArgs): Promise<CrashReportSubmitResult> =>
      ipcRenderer.invoke('crashReports:submit', args),
    copyLatestDiagnostics: (args?: { reportId?: string; notes?: string }) =>
      ipcRenderer.invoke('crashReports:copyLatestDiagnostics', args)
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

    repoSlug: (args: { repoPath: string; repoId?: string }): Promise<unknown> =>
      ipcRenderer.invoke('gh:repoSlug', args),

    repoUpstream: (args: { repoPath: string; repoId?: string }): Promise<unknown> =>
      ipcRenderer.invoke('gh:repoUpstream', args),

    prForBranch: (args: {
      repoPath: string
      repoId?: string
      branch: string
      linkedPRNumber?: number | null
      fallbackPRNumber?: number | null
      acceptMergedFallbackPR?: boolean
      currentHeadOid?: string | null
    }): Promise<unknown> => ipcRenderer.invoke('gh:prForBranch', args),

    refreshPRNow: (args: { candidate: GitHubPRRefreshCandidate }): Promise<unknown> =>
      ipcRenderer.invoke('gh:refreshPRNow', args),

    enqueuePRRefresh: (args: {
      candidate: GitHubPRRefreshCandidate
      reason: GitHubPRRefreshReason
      priority?: number
    }): Promise<unknown> => ipcRenderer.invoke('gh:enqueuePRRefresh', args),

    reportVisiblePRRefreshCandidates: (args: {
      candidates: GitHubPRRefreshCandidate[]
      generation: number
    }): Promise<unknown> => ipcRenderer.invoke('gh:reportVisiblePRRefreshCandidates', args),

    onPRRefreshEvent: (callback: (event: GitHubPRRefreshEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, event: GitHubPRRefreshEvent): void =>
        callback(event)
      ipcRenderer.on('gh:prRefreshEvent', listener)
      return () => ipcRenderer.removeListener('gh:prRefreshEvent', listener)
    },

    issue: (args: {
      repoPath: string
      repoId?: string
      sourceContext?: TaskSourceContext | null
      number: number
    }): Promise<unknown> => ipcRenderer.invoke('gh:issue', args),

    workItem: (args: {
      repoPath: string
      repoId?: string
      sourceContext?: TaskSourceContext | null
      number: number
      type?: 'issue' | 'pr'
    }): Promise<unknown> => ipcRenderer.invoke('gh:workItem', args),

    workItemByOwnerRepo: (args: {
      repoPath: string
      repoId?: string
      owner: string
      repo: string
      number: number
      type: 'issue' | 'pr'
    }): Promise<unknown> => ipcRenderer.invoke('gh:workItemByOwnerRepo', args),

    workItemDetails: (args: {
      repoPath: string
      repoId?: string
      sourceContext?: TaskSourceContext | null
      number: number
      type?: 'issue' | 'pr'
    }): Promise<unknown> => ipcRenderer.invoke('gh:workItemDetails', args),

    notifyWorkItemMutated: (args: {
      repoPath: string
      repoId?: string
      type: 'issue' | 'pr'
      number: number
    }): Promise<boolean> => ipcRenderer.invoke('gh:notifyWorkItemMutated', args),

    prFileContents: (args: {
      repoPath: string
      repoId?: string
      sourceContext?: TaskSourceContext | null
      prNumber: number
      path: string
      oldPath?: string
      status: string
      headSha: string
      baseSha: string
    }): Promise<unknown> => ipcRenderer.invoke('gh:prFileContents', args),

    listIssues: (args: { repoPath: string; repoId?: string; limit?: number }): Promise<unknown[]> =>
      ipcRenderer.invoke('gh:listIssues', args),

    createIssue: (args: {
      repoPath: string
      repoId?: string
      sourceContext?: TaskSourceContext | null
      title: string
      body: string
      labels?: string[]
      assignees?: string[]
    }): Promise<GitHubCreateIssueResult> => ipcRenderer.invoke('gh:createIssue', args),

    countWorkItems: (args: {
      repoPath: string
      repoId?: string
      query?: string
    }): Promise<number> => ipcRenderer.invoke('gh:countWorkItems', args),

    listWorkItems: (args: {
      repoPath: string
      repoId?: string
      limit?: number
      query?: string
      before?: string
      noCache?: boolean
    }): Promise<ListWorkItemsResult<Omit<GitHubWorkItem, 'repoId'>>> =>
      ipcRenderer.invoke('gh:listWorkItems', args),

    prChecks: (args: {
      repoPath: string
      repoId?: string
      sourceContext?: TaskSourceContext | null
      prNumber: number
      headSha?: string
      prRepo?: { owner: string; repo: string } | null
      noCache?: boolean
    }): Promise<unknown[]> => ipcRenderer.invoke('gh:prChecks', args),

    prCheckDetails: (args: {
      repoPath: string
      repoId?: string
      sourceContext?: TaskSourceContext | null
      checkRunId?: number
      workflowRunId?: number
      checkName?: string
      url?: string | null
      prRepo?: { owner: string; repo: string } | null
    }): Promise<unknown | null> => ipcRenderer.invoke('gh:prCheckDetails', args),

    rerunPRChecks: (args: {
      repoPath: string
      repoId?: string
      sourceContext?: TaskSourceContext | null
      prNumber: number
      headSha?: string
      failedOnly?: boolean
    }): Promise<{ ok: true; count: number } | { ok: false; error: string }> =>
      ipcRenderer.invoke('gh:rerunPRChecks', args),

    prComments: (args: {
      repoPath: string
      repoId?: string
      sourceContext?: TaskSourceContext | null
      prNumber: number
      prRepo?: { owner: string; repo: string } | null
      noCache?: boolean
    }): Promise<unknown[]> => ipcRenderer.invoke('gh:prComments', args),

    resolveReviewThread: (args: {
      repoPath: string
      repoId?: string
      sourceContext?: TaskSourceContext | null
      threadId: string
      resolve: boolean
    }): Promise<boolean> => ipcRenderer.invoke('gh:resolveReviewThread', args),

    setPRFileViewed: (args: {
      repoPath: string
      repoId?: string
      sourceContext?: TaskSourceContext | null
      prNumber: number
      pullRequestId: string
      path: string
      viewed: boolean
    }): Promise<boolean> => ipcRenderer.invoke('gh:setPRFileViewed', args),

    updatePRTitle: (args: {
      repoPath: string
      repoId?: string
      prNumber: number
      title: string
      prRepo?: { owner: string; repo: string } | null
    }): Promise<boolean> => ipcRenderer.invoke('gh:updatePRTitle', args),

    mergePR: (args: {
      repoPath: string
      repoId?: string
      sourceContext?: TaskSourceContext | null
      prNumber: number
      method?: 'merge' | 'squash' | 'rebase'
      prRepo?: { owner: string; repo: string } | null
    }): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('gh:mergePR', args),

    setPRAutoMerge: (args: {
      repoPath: string
      repoId?: string
      sourceContext?: TaskSourceContext | null
      prNumber: number
      enabled: boolean
      method?: 'merge' | 'squash' | 'rebase'
      prRepo?: { owner: string; repo: string } | null
    }): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('gh:setPRAutoMerge', args),

    updatePRState: (args: {
      repoPath: string
      repoId?: string
      sourceContext?: TaskSourceContext | null
      prNumber: number
      updates: { state: 'open' | 'closed' }
    }): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('gh:updatePRState', args),

    requestPRReviewers: (args: {
      repoPath: string
      repoId?: string
      sourceContext?: TaskSourceContext | null
      prNumber: number
      reviewers: string[]
    }): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('gh:requestPRReviewers', args),

    removePRReviewers: (args: {
      repoPath: string
      repoId?: string
      sourceContext?: TaskSourceContext | null
      prNumber: number
      reviewers: string[]
    }): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('gh:removePRReviewers', args),

    updateIssue: (args: {
      repoPath: string
      repoId?: string
      sourceContext?: TaskSourceContext | null
      number: number
      updates: unknown
    }): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('gh:updateIssue', args),

    addIssueComment: (args: {
      repoPath: string
      repoId?: string
      sourceContext?: TaskSourceContext | null
      number: number
      body: string
      type?: 'issue' | 'pr'
      prRepo?: { owner: string; repo: string } | null
    }): Promise<GitHubCommentResult> => ipcRenderer.invoke('gh:addIssueComment', args),

    addPRReviewCommentReply: (args: {
      repoPath: string
      repoId?: string
      sourceContext?: TaskSourceContext | null
      prNumber: number
      commentId: number
      body: string
      threadId?: string
      path?: string
      line?: number
      prRepo?: { owner: string; repo: string } | null
    }): Promise<GitHubCommentResult> => ipcRenderer.invoke('gh:addPRReviewCommentReply', args),

    addPRReviewComment: (args: {
      repoPath: string
      repoId?: string
      sourceContext?: TaskSourceContext | null
      prNumber: number
      commitId: string
      path: string
      line: number
      startLine?: number
      body: string
    }): Promise<GitHubCommentResult> => ipcRenderer.invoke('gh:addPRReviewComment', args),

    listLabels: (args: {
      repoPath: string
      repoId?: string
      sourceContext?: TaskSourceContext | null
    }): Promise<string[]> => ipcRenderer.invoke('gh:listLabels', args),

    listAssignableUsers: (args: {
      repoPath: string
      repoId?: string
      sourceContext?: TaskSourceContext | null
    }): Promise<GitHubAssignableUser[]> => ipcRenderer.invoke('gh:listAssignableUsers', args),

    // Why: the app renderer owns the work-item-details cache. Main targets this
    // bridge for non-origin mutations; origin callers already updated their
    // cache optimistically — see src/main/ipc/github.ts.
    onWorkItemMutated: (
      callback: (payload: {
        repoPath: string
        repoId?: string
        type: 'issue' | 'pr'
        number: number
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: { repoPath: string; repoId?: string; type: 'issue' | 'pr'; number: number }
      ): void => callback(payload)
      ipcRenderer.on('gh:workItemMutated', listener)
      return () => ipcRenderer.removeListener('gh:workItemMutated', listener)
    },

    checkOrcaStarred: (): Promise<boolean | null> => ipcRenderer.invoke('gh:checkOrcaStarred'),
    starOrca: (source: AppStarSource): Promise<boolean> =>
      ipcRenderer.invoke('gh:starOrca', source),

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

  hostedReview: {
    forBranch: (args: HostedReviewForBranchArgs): Promise<unknown> =>
      ipcRenderer.invoke('hostedReview:forBranch', args),
    getCreationEligibility: (args: unknown): Promise<unknown> =>
      ipcRenderer.invoke('hostedReview:getCreationEligibility', args),
    create: (args: unknown): Promise<unknown> => ipcRenderer.invoke('hostedReview:create', args)
  },

  // Why: GitLab bindings live in `./gitlab` so adding or changing a
  // `gl.*` channel doesn't surface as a merge conflict on every
  // upstream sync of this central preload file.
  gl: glApi,

  linear: {
    connect: (args: {
      apiKey: string
    }): Promise<{ ok: true; viewer: unknown } | { ok: false; error: string }> =>
      ipcRenderer.invoke('linear:connect', args),

    disconnect: (args?: { workspaceId?: string }): Promise<void> =>
      ipcRenderer.invoke('linear:disconnect', args),

    selectWorkspace: (args: { workspaceId: string }): Promise<unknown> =>
      ipcRenderer.invoke('linear:selectWorkspace', args),

    status: (): Promise<unknown> => ipcRenderer.invoke('linear:status'),

    testConnection: (args?: {
      workspaceId?: string
    }): Promise<{ ok: true; viewer: unknown } | { ok: false; error: string }> =>
      ipcRenderer.invoke('linear:testConnection', args),

    searchIssues: (args: {
      query: string
      limit?: number
      workspaceId?: string
    }): Promise<unknown[]> => ipcRenderer.invoke('linear:searchIssues', args),

    listIssues: (args?: {
      filter?: 'assigned' | 'created' | 'all' | 'completed'
      limit?: number
      workspaceId?: string
      attributeFilter?: unknown
    }): Promise<unknown> => ipcRenderer.invoke('linear:listIssues', args),

    createIssue: (args: {
      teamId: string
      title: string
      description?: string
      workspaceId?: string
      parentIssueId?: string
      projectId?: string | null
      stateId?: string
      priority?: number
      assigneeId?: string | null
      labelIds?: string[]
    }): Promise<
      | { ok: true; id: string; identifier: string; title: string; url: string }
      | { ok: false; error: string }
    > => ipcRenderer.invoke('linear:createIssue', args),

    getIssue: (args: { id: string; workspaceId?: string }): Promise<unknown> =>
      ipcRenderer.invoke('linear:getIssue', args),

    updateIssue: (args: {
      id: string
      updates: unknown
      workspaceId?: string
    }): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('linear:updateIssue', args),

    addIssueComment: (args: {
      issueId: string
      body: string
      workspaceId?: string
    }): Promise<{ ok: true; id: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke('linear:addIssueComment', args),

    issueComments: (args: { issueId: string; workspaceId?: string }): Promise<unknown[]> =>
      ipcRenderer.invoke('linear:issueComments', args),

    listTeams: (args?: { workspaceId?: string }): Promise<unknown[]> =>
      ipcRenderer.invoke('linear:listTeams', args),

    listProjects: (args?: {
      query?: string
      limit?: number
      workspaceId?: string
      force?: boolean
    }): Promise<unknown> => ipcRenderer.invoke('linear:listProjects', args),

    createProject: (args: {
      name: string
      description?: string
      content?: string
      teamIds: string[]
      workspaceId?: string
      leadId?: string | null
      memberIds?: string[]
      labelIds?: string[]
      priority?: number
      startDate?: string
      targetDate?: string
    }): Promise<{ ok: true; project: LinearProjectDetail } | { ok: false; error: string }> =>
      ipcRenderer.invoke('linear:createProject', args),

    getProject: (args: { id: string; workspaceId: string; force?: boolean }): Promise<unknown> =>
      ipcRenderer.invoke('linear:getProject', args),

    listProjectIssues: (args: {
      projectId: string
      limit?: number
      workspaceId: string
      force?: boolean
    }): Promise<unknown> => ipcRenderer.invoke('linear:listProjectIssues', args),

    listCustomViews: (args: {
      model: string
      limit?: number
      workspaceId?: string
      force?: boolean
    }): Promise<unknown> => ipcRenderer.invoke('linear:listCustomViews', args),

    getCustomView: (args: {
      viewId: string
      model: string
      workspaceId: string
      force?: boolean
    }): Promise<unknown> => ipcRenderer.invoke('linear:getCustomView', args),

    listCustomViewIssues: (args: {
      viewId: string
      limit?: number
      workspaceId: string
      force?: boolean
    }): Promise<unknown> => ipcRenderer.invoke('linear:listCustomViewIssues', args),

    listCustomViewProjects: (args: {
      viewId: string
      limit?: number
      workspaceId: string
      force?: boolean
    }): Promise<unknown> => ipcRenderer.invoke('linear:listCustomViewProjects', args),

    teamStates: (args: { teamId: string; workspaceId?: string }): Promise<unknown[]> =>
      ipcRenderer.invoke('linear:teamStates', args),

    teamLabels: (args: { teamId: string; workspaceId?: string }): Promise<unknown[]> =>
      ipcRenderer.invoke('linear:teamLabels', args),

    teamMembers: (args: { teamId: string; workspaceId?: string }): Promise<unknown[]> =>
      ipcRenderer.invoke('linear:teamMembers', args)
  },

  jira: {
    connect: (args: {
      siteUrl: string
      email: string
      apiToken: string
    }): Promise<{ ok: true; viewer: unknown } | { ok: false; error: string }> =>
      ipcRenderer.invoke('jira:connect', args),

    disconnect: (args?: { siteId?: string }): Promise<void> =>
      ipcRenderer.invoke('jira:disconnect', args),

    selectSite: (args: { siteId: string }): Promise<unknown> =>
      ipcRenderer.invoke('jira:selectSite', args),

    status: (): Promise<unknown> => ipcRenderer.invoke('jira:status'),

    testConnection: (args?: {
      siteId?: string
    }): Promise<{ ok: true; viewer: unknown } | { ok: false; error: string }> =>
      ipcRenderer.invoke('jira:testConnection', args),

    searchIssues: (args: { jql: string; limit?: number; siteId?: string }): Promise<unknown[]> =>
      ipcRenderer.invoke('jira:searchIssues', args),

    listIssues: (args?: {
      filter?: 'assigned' | 'reported' | 'all' | 'done'
      limit?: number
      siteId?: string
    }): Promise<unknown[]> => ipcRenderer.invoke('jira:listIssues', args),

    getIssue: (args: { key: string; siteId?: string }): Promise<unknown> =>
      ipcRenderer.invoke('jira:getIssue', args),

    createIssue: (args: {
      siteId?: string
      projectId: string
      issueTypeId: string
      title: string
      description?: string
      customFields?: Record<string, unknown>
    }): Promise<
      { ok: true; id: string; key: string; url: string } | { ok: false; error: string }
    > => ipcRenderer.invoke('jira:createIssue', args),

    updateIssue: (args: {
      key: string
      updates: unknown
      siteId?: string
    }): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('jira:updateIssue', args),

    addIssueComment: (args: {
      key: string
      body: string
      siteId?: string
    }): Promise<{ ok: true; id: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke('jira:addIssueComment', args),

    issueComments: (args: { key: string; siteId?: string }): Promise<unknown[]> =>
      ipcRenderer.invoke('jira:issueComments', args),

    listProjects: (args?: { siteId?: string }): Promise<unknown[]> =>
      ipcRenderer.invoke('jira:listProjects', args),

    listIssueTypes: (args: { projectIdOrKey: string; siteId?: string }): Promise<unknown[]> =>
      ipcRenderer.invoke('jira:listIssueTypes', args),

    listCreateFields: (args: {
      projectIdOrKey: string
      issueTypeId: string
      siteId?: string
    }): Promise<unknown[]> => ipcRenderer.invoke('jira:listCreateFields', args),

    listPriorities: (args?: { siteId?: string }): Promise<unknown[]> =>
      ipcRenderer.invoke('jira:listPriorities', args),

    listAssignableUsers: (args: {
      key: string
      query?: string
      siteId?: string
    }): Promise<unknown[]> => ipcRenderer.invoke('jira:listAssignableUsers', args),

    listTransitions: (args: { key: string; siteId?: string }): Promise<unknown[]> =>
      ipcRenderer.invoke('jira:listTransitions', args),
    getProjectStatusOrder: (args: {
      projectKey: string
      siteId?: string
    }): Promise<JiraProjectStatusOrder> => ipcRenderer.invoke('jira:getProjectStatusOrder', args)
  },

  starNag: {
    onShow: (
      callback: (payload?: { mode?: 'gh' | 'web'; surface?: 'card' | 'toast' }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload?: { mode?: 'gh' | 'web'; surface?: 'card' | 'toast' }
      ): void => callback(payload)
      ipcRenderer.on('star-nag:show', listener)
      return () => ipcRenderer.removeListener('star-nag:show', listener)
    },
    onHide: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('star-nag:hide', listener)
      return () => ipcRenderer.removeListener('star-nag:hide', listener)
    },
    dismiss: (): Promise<void> => ipcRenderer.invoke('star-nag:dismiss'),
    later: (): Promise<void> => ipcRenderer.invoke('star-nag:later'),
    complete: (): Promise<void> => ipcRenderer.invoke('star-nag:complete'),
    disable: (): Promise<void> => ipcRenderer.invoke('star-nag:disable'),
    openWeb: (): Promise<void> => ipcRenderer.invoke('star-nag:openWeb'),
    starOrca: (): Promise<boolean> => ipcRenderer.invoke('star-nag:starOrca'),
    forceShow: (): Promise<void> => ipcRenderer.invoke('star-nag:forceShow'),
    agentValueMoment: (): Promise<
      { status: 'ready'; mode: 'gh' | 'web' } | { status: 'skipped' }
    > => ipcRenderer.invoke('star-nag:agentValueMoment'),
    showAgentValueMoment: (): Promise<void> => ipcRenderer.invoke('star-nag:showAgentValueMoment'),
    onboardingCompleted: (): Promise<void> => ipcRenderer.invoke('star-nag:onboardingCompleted')
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

  // Why: diagnostics is the renderer-facing surface for the error-tracking
  // lane (telemetry-error-tracking.md §User controls). Handlers type-narrow
  // their inputs in main (renderer is untrusted by design); the bridges here
  // are deliberately loose for the same reason the telemetry bridges are.
  diagnostics: {
    getStatus: (): Promise<unknown> => ipcRenderer.invoke('diagnostics:getStatus'),
    collectBundle: (lookbackMinutes?: number): Promise<unknown> =>
      ipcRenderer.invoke('diagnostics:collectBundle', lookbackMinutes),
    openBundlePreview: (bundleSubmissionId: string): Promise<void> =>
      ipcRenderer.invoke('diagnostics:openBundlePreview', bundleSubmissionId),
    discardBundlePreview: (bundleSubmissionId: string): Promise<void> =>
      ipcRenderer.invoke('diagnostics:discardBundlePreview', bundleSubmissionId),
    uploadBundle: (bundleSubmissionId: string): Promise<unknown> =>
      ipcRenderer.invoke('diagnostics:uploadBundle', bundleSubmissionId),
    deleteBundle: (ticketId: string): Promise<void> =>
      ipcRenderer.invoke('diagnostics:deleteBundle', ticketId)
  },

  settings: {
    get: (): Promise<unknown> => ipcRenderer.invoke('settings:get'),

    // Why: blocking read for the few startup decisions (terminal side-effect
    // authority) that cannot wait for async hydration. Call sparingly.
    getSync: (): unknown => ipcRenderer.sendSync('settings:get-sync'),

    set: (args: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('settings:set', args),

    listFonts: (): Promise<string[]> => ipcRenderer.invoke('settings:listFonts'),

    previewGhosttyImport: (): Promise<GhosttyImportPreview> =>
      ipcRenderer.invoke('settings:previewGhosttyImport'),

    previewWarpThemeImport: (source: WarpThemeImportSource): Promise<WarpThemeImportPreview> =>
      ipcRenderer.invoke('settings:previewWarpThemeImport', source),

    onChanged: (callback: (updates: Record<string, unknown>) => void): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        updates: Record<string, unknown>
      ): void => callback(updates)
      ipcRenderer.on('settings:changed', listener)
      return () => ipcRenderer.removeListener('settings:changed', listener)
    }
  },

  localhostWorktreeLabels: {
    register: (args: LocalhostWorktreeLabelRoute): Promise<LocalhostWorktreeLabelResult> =>
      ipcRenderer.invoke('localhostWorktreeLabels:register', args)
  } satisfies PreloadApi['localhostWorktreeLabels'],

  keybindings: {
    get: (): Promise<KeybindingFileSnapshot> => ipcRenderer.invoke('keybindings:get'),
    ensureFile: (): Promise<KeybindingFileSnapshot> => ipcRenderer.invoke('keybindings:ensureFile'),
    setAction: (args: {
      actionId: KeybindingActionId
      bindings: string[] | null
    }): Promise<KeybindingFileSnapshot> => ipcRenderer.invoke('keybindings:setAction', args),
    reload: (): Promise<KeybindingFileSnapshot> => ipcRenderer.invoke('keybindings:reload'),
    openFile: (): Promise<KeybindingFileSnapshot> => ipcRenderer.invoke('keybindings:openFile'),
    revealFile: (): Promise<KeybindingFileSnapshot> => ipcRenderer.invoke('keybindings:revealFile'),
    onChanged: (callback: (snapshot: KeybindingFileSnapshot) => void): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        snapshot: KeybindingFileSnapshot
      ): void => callback(snapshot)
      ipcRenderer.on('keybindings:changed', listener)
      return () => ipcRenderer.removeListener('keybindings:changed', listener)
    }
  },

  codexAccounts: {
    list: (): Promise<unknown> => ipcRenderer.invoke('codexAccounts:list'),
    add: (args?: { runtime?: 'host' | 'wsl'; wslDistro?: string | null }): Promise<unknown> =>
      ipcRenderer.invoke('codexAccounts:add', args),
    reauthenticate: (args: { accountId: string }): Promise<unknown> =>
      ipcRenderer.invoke('codexAccounts:reauthenticate', args),
    remove: (args: { accountId: string }): Promise<unknown> =>
      ipcRenderer.invoke('codexAccounts:remove', args),
    select: (args: {
      accountId: string | null
      runtime?: 'host' | 'wsl'
      wslDistro?: string | null
    }): Promise<unknown> => ipcRenderer.invoke('codexAccounts:select', args)
  },

  claudeAccounts: {
    list: (): Promise<unknown> => ipcRenderer.invoke('claudeAccounts:list'),
    add: (args?: { runtime?: 'host' | 'wsl'; wslDistro?: string | null }): Promise<unknown> =>
      ipcRenderer.invoke('claudeAccounts:add', args),
    cancelPendingLogin: (): Promise<boolean> =>
      ipcRenderer.invoke('claudeAccounts:cancelPendingLogin'),
    reauthenticate: (args: { accountId: string }): Promise<unknown> =>
      ipcRenderer.invoke('claudeAccounts:reauthenticate', args),
    remove: (args: { accountId: string }): Promise<unknown> =>
      ipcRenderer.invoke('claudeAccounts:remove', args),
    select: (args: {
      accountId: string | null
      runtime?: 'host' | 'wsl'
      wslDistro?: string | null
    }): Promise<unknown> => ipcRenderer.invoke('claudeAccounts:select', args)
  },

  cli: {
    getInstallStatus: (): Promise<CliInstallStatus> => ipcRenderer.invoke('cli:getInstallStatus'),
    install: (): Promise<CliInstallStatus> => ipcRenderer.invoke('cli:install'),
    remove: (): Promise<CliInstallStatus> => ipcRenderer.invoke('cli:remove'),
    getWslInstallStatus: (args?: { distro?: string | null }): Promise<CliInstallStatus> =>
      ipcRenderer.invoke('cli:getWslInstallStatus', args),
    installWsl: (args?: { distro?: string | null }): Promise<CliInstallStatus> =>
      ipcRenderer.invoke('cli:installWsl', args),
    removeWsl: (args?: { distro?: string | null }): Promise<CliInstallStatus> =>
      ipcRenderer.invoke('cli:removeWsl', args)
  },

  agentHooks: {
    claudeStatus: (): Promise<AgentHookInstallStatus> =>
      ipcRenderer.invoke('agentHooks:claudeStatus'),
    openClaudeStatus: (): Promise<AgentHookInstallStatus> =>
      ipcRenderer.invoke('agentHooks:openClaudeStatus'),
    codexStatus: (): Promise<AgentHookInstallStatus> =>
      ipcRenderer.invoke('agentHooks:codexStatus'),
    geminiStatus: (): Promise<AgentHookInstallStatus> =>
      ipcRenderer.invoke('agentHooks:geminiStatus'),
    antigravityStatus: (): Promise<AgentHookInstallStatus> =>
      ipcRenderer.invoke('agentHooks:antigravityStatus'),
    ampStatus: (): Promise<AgentHookInstallStatus> => ipcRenderer.invoke('agentHooks:ampStatus'),
    cursorStatus: (): Promise<AgentHookInstallStatus> =>
      ipcRenderer.invoke('agentHooks:cursorStatus'),
    droidStatus: (): Promise<AgentHookInstallStatus> =>
      ipcRenderer.invoke('agentHooks:droidStatus'),
    commandCodeStatus: (): Promise<AgentHookInstallStatus> =>
      ipcRenderer.invoke('agentHooks:commandCodeStatus'),
    grokStatus: (): Promise<AgentHookInstallStatus> => ipcRenderer.invoke('agentHooks:grokStatus'),
    devinStatus: (): Promise<AgentHookInstallStatus> =>
      ipcRenderer.invoke('agentHooks:devinStatus'),
    copilotStatus: (): Promise<AgentHookInstallStatus> =>
      ipcRenderer.invoke('agentHooks:copilotStatus'),
    hermesStatus: (): Promise<AgentHookInstallStatus> =>
      ipcRenderer.invoke('agentHooks:hermesStatus'),
    kimiStatus: (): Promise<AgentHookInstallStatus> => ipcRenderer.invoke('agentHooks:kimiStatus')
  },

  agentTrust: {
    markTrusted: (args: {
      preset: 'cursor' | 'copilot' | 'codex'
      workspacePath: string
      connectionId?: string
    }): Promise<void> => ipcRenderer.invoke('agentTrust:markTrusted', args)
  },

  preflight: {
    check: (args?: {
      force?: boolean
    }): Promise<{
      git: { installed: boolean }
      gh: { installed: boolean; authenticated: boolean }
      glab?: { installed: boolean; authenticated: boolean }
      bitbucket?: { configured: boolean; authenticated: boolean; account: string | null }
      azureDevOps?: {
        configured: boolean
        authenticated: boolean
        account: string | null
        baseUrl: string | null
        tokenConfigured: boolean
      }
      gitea?: {
        configured: boolean
        authenticated: boolean
        account: string | null
        baseUrl: string | null
        tokenConfigured: boolean
      }
      linear: { connected: boolean }
    }> => ipcRenderer.invoke('preflight:check', args),
    detectAgents: (args?: PreflightRuntimeContext): Promise<string[]> =>
      ipcRenderer.invoke('preflight:detectAgents', args),
    refreshAgents: (args?: PreflightRuntimeContext): Promise<RefreshAgentsResult> =>
      ipcRenderer.invoke('preflight:refreshAgents', args),
    detectRemoteAgents: (args: { connectionId: string }): Promise<string[]> =>
      ipcRenderer.invoke('preflight:detectRemoteAgents', args),
    detectRemoteWindowsTerminalCapabilities: (args: {
      connectionId: string
    }): Promise<{
      wslAvailable: boolean
      wslDistros: string[]
      pwshAvailable: boolean
      gitBashAvailable: boolean
      hostPlatform: NodeJS.Platform | null
    }> => ipcRenderer.invoke('preflight:detectRemoteWindowsTerminalCapabilities', args)
  },

  notifications: {
    dispatch: (args: Record<string, unknown>): Promise<NotificationDispatchResult> =>
      ipcRenderer.invoke('notifications:dispatch', args),
    dismiss: (ids: string[]): Promise<NotificationDismissResult> =>
      ipcRenderer.invoke('notifications:dismiss', ids),
    openSystemSettings: (): Promise<void> => ipcRenderer.invoke('notifications:openSystemSettings'),
    getPermissionStatus: (): Promise<NotificationPermissionStatusResult> =>
      ipcRenderer.invoke('notifications:getPermissionStatus'),
    probeDelivery: (args?: { force?: boolean }): Promise<NotificationDeliveryProbeResult> =>
      ipcRenderer.invoke('notifications:probeDelivery', args),
    playSound: async (options?: {
      force?: boolean
      volume?: number
    }): Promise<NotificationSoundResult> => {
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
        if (typeof options?.volume === 'number' && Number.isFinite(options.volume)) {
          audio.volume = Math.min(1, Math.max(0, options.volume / 100))
        }
        isNotificationSoundPlaying = true
        cleanupNotificationSoundPlayback?.()
        const release = (): void => {
          cleanup()
          if (cleanupNotificationSoundPlayback === cleanup) {
            cleanupNotificationSoundPlayback = null
          }
          isNotificationSoundPlaying = false
        }
        const cleanup = (): void => {
          audio.removeEventListener('ended', release)
          audio.removeEventListener('error', release)
        }
        cleanupNotificationSoundPlayback = cleanup
        audio.addEventListener('ended', release)
        audio.addEventListener('error', release)
        try {
          await audio.play()
        } catch {
          release()
          return { played: false, reason: 'playback-failed' }
        }
        return { played: true }
      } catch {
        clearNotificationSoundPlaybackState()
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

  computerUsePermissions: {
    getStatus: (): Promise<unknown> => ipcRenderer.invoke('computerUsePermissions:getStatus'),
    openSetup: (args?: { id?: string }): Promise<unknown> =>
      ipcRenderer.invoke('computerUsePermissions:openSetup', args),
    reset: (): Promise<unknown> => ipcRenderer.invoke('computerUsePermissions:reset')
  },

  shell: {
    openPath: (path: string): Promise<void> => ipcRenderer.invoke('shell:openPath', path),

    openInFileManager: (path: string): Promise<ShellOpenLocalPathResult> =>
      ipcRenderer.invoke('shell:openInFileManager', path),

    openInExternalEditor: (path: string, command?: string): Promise<ShellOpenLocalPathResult> =>
      ipcRenderer.invoke('shell:openInExternalEditor', path, command),

    openUrl: (url: string): Promise<void> => ipcRenderer.invoke('shell:openUrl', url),

    openFilePath: (path: string): Promise<boolean> =>
      ipcRenderer.invoke('shell:openFilePath', path),

    openFileUri: (uri: string): Promise<void> => ipcRenderer.invoke('shell:openFileUri', uri),

    pathExists: (path: string): Promise<boolean> => ipcRenderer.invoke('shell:pathExists', path),

    pickAttachment: (): Promise<string | null> => ipcRenderer.invoke('shell:pickAttachment'),

    pickImage: (): Promise<string | null> => ipcRenderer.invoke('shell:pickImage'),

    pickRepoIconImage: (): Promise<{ dataUrl: string; fileName: string } | null> =>
      ipcRenderer.invoke('shell:pickRepoIconImage'),

    pickAudio: (): Promise<string | null> => ipcRenderer.invoke('shell:pickAudio'),

    pickDirectory: (args: { defaultPath?: string }): Promise<string | null> =>
      ipcRenderer.invoke('shell:pickDirectory', args),

    copyFile: (args: { srcPath: string; destPath: string }): Promise<void> =>
      ipcRenderer.invoke('shell:copyFile', args)
  },

  skills: {
    discover: (target?: SkillDiscoveryTarget): Promise<SkillDiscoveryResult> =>
      ipcRenderer.invoke('skills:discover', target)
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

    setAnnotationViewportBridge: (args): Promise<boolean> =>
      ipcRenderer.invoke('browser:setAnnotationViewportBridge', args),

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
        savePath: string
        status: 'downloading'
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
          savePath: string
          status: 'downloading'
        }
      ) => callback(data)
      ipcRenderer.on('browser:download-requested', listener)
      return () => ipcRenderer.removeListener('browser:download-requested', listener)
    },

    onDownloadProgress: (
      callback: (event: {
        browserPageId?: string
        downloadId: string
        receivedBytes: number
        totalBytes: number | null
        state: 'progressing' | 'interrupted' | null
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          browserPageId?: string
          downloadId: string
          receivedBytes: number
          totalBytes: number | null
          state: 'progressing' | 'interrupted' | null
        }
      ) => callback(data)
      ipcRenderer.on('browser:download-progress', listener)
      return () => ipcRenderer.removeListener('browser:download-progress', listener)
    },

    onDownloadFinished: (
      callback: (event: {
        browserPageId?: string
        downloadId: string
        status: 'completed' | 'canceled' | 'failed'
        savePath: string | null
        error: string | null
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          browserPageId?: string
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
        selectionText: string
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
          selectionText: string
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

    onActivateView: (
      callback: (data: { worktreeId?: string; browserPageId?: string }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { worktreeId?: string; browserPageId?: string }
      ) => callback(data)
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

  emulator: {
    startFrameStream: (args: {
      streamUrl: string
      streamKey?: string
    }): Promise<{
      streamId: string
    }> => ipcRenderer.invoke('emulator:frameStreamStart', args),
    stopFrameStream: (args: { streamId: string }): Promise<void> =>
      ipcRenderer.invoke('emulator:frameStreamStop', args),
    onFrameStreamFrame: (
      callback: (data: { streamId: string; bytes: ArrayBuffer }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { streamId: string; bytes: ArrayBuffer }
      ) => callback(data)
      ipcRenderer.on('emulator:frameStreamFrame', listener)
      return () => ipcRenderer.removeListener('emulator:frameStreamFrame', listener)
    },
    onFrameStreamError: (
      callback: (data: { streamId: string; message: string }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { streamId: string; message: string }
      ) => callback(data)
      ipcRenderer.on('emulator:frameStreamError', listener)
      return () => ipcRenderer.removeListener('emulator:frameStreamError', listener)
    },
    startVideoStream: (args: {
      deviceId: string
      streamId: string
    }): Promise<{ streamId: string }> => ipcRenderer.invoke('emulator:videoStreamStart', args),
    stopVideoStream: (args: { streamId: string }): Promise<void> =>
      ipcRenderer.invoke('emulator:videoStreamStop', args),
    onVideoStreamMeta: (
      callback: (data: {
        streamId: string
        deviceId: string
        meta: { codecId: string; width: number; height: number }
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          streamId: string
          deviceId: string
          meta: { codecId: string; width: number; height: number }
        }
      ) => callback(data)
      ipcRenderer.on('emulator:videoStreamMeta', listener)
      return () => ipcRenderer.removeListener('emulator:videoStreamMeta', listener)
    },
    onVideoStreamFrame: (
      callback: (data: {
        streamId: string
        deviceId: string
        config: boolean
        keyFrame: boolean
        bytes: ArrayBuffer
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          streamId: string
          deviceId: string
          config: boolean
          keyFrame: boolean
          bytes: ArrayBuffer
        }
      ) => callback(data)
      ipcRenderer.on('emulator:videoStreamFrame', listener)
      return () => ipcRenderer.removeListener('emulator:videoStreamFrame', listener)
    },
    onPaneFocus: (callback: (data: { worktreeId: string }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { worktreeId: string }) =>
        callback(data)
      ipcRenderer.on('emulator:pane-focus', listener)
      return () => ipcRenderer.removeListener('emulator:pane-focus', listener)
    },
    onAutoAttach: (
      callback: (data: {
        worktreeId: string
        info: { deviceUdid: string; streamUrl: string; wsUrl: string; axUrl?: string }
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          worktreeId: string
          info: { deviceUdid: string; streamUrl: string; wsUrl: string; axUrl?: string }
        }
      ) => callback(data)
      ipcRenderer.on('ui:emulatorAutoAttach', listener)
      return () => ipcRenderer.removeListener('ui:emulatorAutoAttach', listener)
    }
  },

  hooks: {
    check: (args: {
      repoId: string
      hostId?: ExecutionHostId
    }): Promise<{
      status?: 'ok' | 'error'
      hasHooks: boolean
      hooks: unknown
      mayNeedUpdate: boolean
    }> => ipcRenderer.invoke('hooks:check', args),

    inspectSetupScriptImports: (args: { repoId: string }): Promise<unknown[]> =>
      ipcRenderer.invoke('hooks:inspectSetupScriptImports', args),

    createIssueCommandRunner: (args: {
      repoId: string
      worktreePath: string
      command: string
    }): Promise<{ runnerScriptPath: string; envVars: Record<string, string> }> =>
      ipcRenderer.invoke('hooks:createIssueCommandRunner', args),

    readIssueCommand: (args: {
      repoId: string
    }): Promise<{
      status?: 'ok' | 'error'
      localContent: string | null
      sharedContent: string | null
      effectiveContent: string | null
      localFilePath: string
      source: 'local' | 'shared' | 'none'
    }> => ipcRenderer.invoke('hooks:readIssueCommand', args),

    writeIssueCommand: (args: { repoId: string; content: string }): Promise<void> =>
      ipcRenderer.invoke('hooks:writeIssueCommand', args)
  },

  ephemeralVm: {
    listRecipes: (args) => ipcRenderer.invoke('ephemeralVm:listRecipes', args),
    listRecipeCatalog: () => ipcRenderer.invoke('ephemeralVm:listRecipeCatalog'),
    doctor: (args) => ipcRenderer.invoke('ephemeralVm:doctor', args),
    provision: (args) => ipcRenderer.invoke('ephemeralVm:provision', args),
    cancelProvision: (args) => ipcRenderer.invoke('ephemeralVm:cancelProvision', args),
    onProvisionEvent: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        event: { provisionId: string; stream: 'stdout' | 'stderr'; chunk: string }
      ): void => callback(event)
      ipcRenderer.on('ephemeralVm:provisionEvent', listener)
      return () => ipcRenderer.removeListener('ephemeralVm:provisionEvent', listener)
    },
    listRuntimes: () => ipcRenderer.invoke('ephemeralVm:listRuntimes'),
    attachWorkspace: (args) => ipcRenderer.invoke('ephemeralVm:attachWorkspace', args),
    suspendWorkspace: (args) => ipcRenderer.invoke('ephemeralVm:suspendWorkspace', args),
    resumeWorkspace: (args) => ipcRenderer.invoke('ephemeralVm:resumeWorkspace', args),
    cleanup: (args) => ipcRenderer.invoke('ephemeralVm:cleanup', args),
    getCleanupCommand: (args) => ipcRenderer.invoke('ephemeralVm:getCleanupCommand', args)
  } satisfies PreloadApi['ephemeralVm'],

  cache: {
    getGitHub: () => ipcRenderer.invoke('cache:getGitHub'),
    setGitHub: (args) => ipcRenderer.invoke('cache:setGitHub', args)
  } satisfies PreloadApi['cache'],

  session: {
    // hostId is optional and defaults to 'local' on the main side, so existing
    // call sites that omit it keep targeting the local session partition.
    get: (hostId) => ipcRenderer.invoke('session:get', hostId),
    set: (args, hostId) => ipcRenderer.invoke('session:set', args, hostId),
    patch: (args, hostId) => ipcRenderer.invoke('session:patch', args, hostId),
    readTerminalScrollback: (args) =>
      ipcRenderer.sendSync('session:read-terminal-scrollback-sync', args),
    /** Synchronous session save for beforeunload — blocks until flushed to disk. */
    setSync: (args, hostId) => {
      ipcRenderer.sendSync('session:set-sync', args, hostId)
    }
  } satisfies PreloadApi['session'],

  remoteWorkspace: {
    get: (args) => ipcRenderer.invoke('remoteWorkspace:get', args),
    setForConnectedTargets: (args) =>
      ipcRenderer.invoke('remoteWorkspace:setForConnectedTargets', args),
    listEnabledConnectedTargets: () =>
      ipcRenderer.invoke('remoteWorkspace:listEnabledConnectedTargets'),
    listConnectedClients: (args) =>
      ipcRenderer.invoke('remoteWorkspace:listConnectedClients', args),
    clientId: () => ipcRenderer.invoke('remoteWorkspace:clientId'),
    onChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, data: RemoteWorkspaceChangedEvent) =>
        callback(data)
      ipcRenderer.on('remoteWorkspace:changed', listener)
      return () => ipcRenderer.removeListener('remoteWorkspace:changed', listener)
    }
  } satisfies PreloadApi['remoteWorkspace'],

  updater: {
    getStatus: () => ipcRenderer.invoke('updater:getStatus'),
    getVersion: () => ipcRenderer.invoke('updater:getVersion'),
    check: (options) => ipcRenderer.invoke('updater:check', options),
    download: () => ipcRenderer.invoke('updater:download'),
    dismissNudge: () => ipcRenderer.invoke('updater:dismissNudge'),
    quitAndInstall: async (): Promise<void> => {
      await prepareRendererForAppRestart({
        startedEventName: ORCA_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT,
        abortedEventName: ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT
      })
      try {
        return await ipcRenderer.invoke('updater:quitAndInstall')
      } catch (error) {
        window.dispatchEvent(new Event(ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT))
        throw error
      }
    },
    onStatus: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, status: UpdateStatus) => callback(status)
      ipcRenderer.on('updater:status', listener)
      return () => ipcRenderer.removeListener('updater:status', listener)
    },
    onClearDismissal: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('updater:clearDismissal', listener)
      return () => ipcRenderer.removeListener('updater:clearDismissal', listener)
    }
  } satisfies PreloadApi['updater'],

  notebook: {
    runPythonCell: (args: {
      filePath: string
      code: string
      preamble?: string
      connectionId?: string | null
    }): Promise<{ stdout: string; stderr: string; exitCode: number | null; error?: string }> =>
      ipcRenderer.invoke('notebook:runPythonCell', args)
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
      includeLocalLogMetadata?: boolean
    }): Promise<{
      content: string
      isBinary: boolean
      isImage?: boolean
      mimeType?: string
      fileIdentity?: string
    }> => ipcRenderer.invoke('fs:readFile', args),
    readLocalLogTail: (args: LocalLogTailReadArgs): Promise<LocalLogTailReadResult> =>
      ipcRenderer.invoke('fs:readLocalLogTail', args),
    startLocalLogTail: (args: LocalLogTailWatchArgs): Promise<void> =>
      ipcRenderer.invoke('fs:startLocalLogTail', args),
    stopLocalLogTail: (args: { subscriptionId: string }): Promise<void> =>
      ipcRenderer.invoke('fs:stopLocalLogTail', args),
    onLocalLogTailChanged: (
      callback: (payload: LocalLogTailChangedPayload) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: LocalLogTailChangedPayload
      ): void => callback(payload)
      ipcRenderer.on('fs:localLogTailChanged', listener)
      return () => ipcRenderer.removeListener('fs:localLogTailChanged', listener)
    },
    downloadFile: (args: {
      filePath: string
      connectionId: string
    }): Promise<{ canceled: true } | { canceled: false; destinationPath: string }> =>
      ipcRenderer.invoke('fs:downloadFile', args),
    saveDownloadedFile: (args: {
      suggestedName: string
      content: string
      encoding: 'utf8' | 'base64'
    }): Promise<{ canceled: true } | { canceled: false; destinationPath: string }> =>
      ipcRenderer.invoke('fs:saveDownloadedFile', args),
    startDownloadedFile: (args: {
      suggestedName: string
    }): Promise<
      { canceled: true } | { canceled: false; transferId: string; destinationPath: string }
    > => ipcRenderer.invoke('fs:startDownloadedFile', args),
    appendDownloadedFileChunk: (args: {
      transferId: string
      contentBase64: string
    }): Promise<{ ok: true }> => ipcRenderer.invoke('fs:appendDownloadedFileChunk', args),
    finishDownloadedFile: (args: {
      transferId: string
    }): Promise<{ canceled: false; destinationPath: string }> =>
      ipcRenderer.invoke('fs:finishDownloadedFile', args),
    cancelDownloadedFile: (args: { transferId: string }): Promise<{ ok: true }> =>
      ipcRenderer.invoke('fs:cancelDownloadedFile', args),
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
    copy: (args: {
      sourcePath: string
      destinationPath: string
      connectionId?: string
    }): Promise<void> => ipcRenderer.invoke('fs:copy', args),
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
    pathExists: (args: { filePath: string; connectionId?: string }): Promise<boolean> =>
      ipcRenderer.invoke('fs:pathExists', args),
    listFiles: (args: {
      rootPath: string
      connectionId?: string
      excludePaths?: string[]
      requestToken?: string
    }): Promise<string[]> => ipcRenderer.invoke('fs:listFiles', args),
    cancelListFiles: (args: { requestToken: string }): Promise<void> =>
      ipcRenderer.invoke('fs:cancelListFiles', args),
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
      ensureDir?: boolean
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
    stageExternalPathsForRuntimeUpload: (args: {
      sourcePaths: string[]
    }): Promise<{
      sources: (
        | {
            sourcePath: string
            status: 'staged'
            name: string
            kind: 'file' | 'directory'
            entries: (
              | { relativePath: string; kind: 'directory' }
              | { relativePath: string; kind: 'file'; contentBase64: string }
            )[]
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
    }> => ipcRenderer.invoke('fs:stageExternalPathsForRuntimeUpload', args),
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
    status: (args: {
      worktreePath: string
      connectionId?: string
      includeIgnored?: boolean
      bypassEffectiveUpstreamNegativeCache?: boolean
    }): Promise<unknown> => ipcRenderer.invoke('git:status', args),
    submoduleStatus: (args: {
      worktreePath: string
      submodulePath: string
      connectionId?: string
      area?: GitStagingArea
    }): Promise<unknown> => ipcRenderer.invoke('git:submoduleStatus', args),
    checkIgnored: (args: {
      worktreePath: string
      paths: string[]
      connectionId?: string
    }): Promise<string[]> => ipcRenderer.invoke('git:checkIgnored', args),
    findHugeFoldersToIgnore: (args: { worktreePath: string }): Promise<string[]> =>
      ipcRenderer.invoke('git:findHugeFoldersToIgnore', args),
    appendGitignore: (args: { worktreePath: string; folderName: string }): Promise<boolean> =>
      ipcRenderer.invoke('git:appendGitignore', args),
    history: (
      args: { worktreePath: string; connectionId?: string } & GitHistoryOptions
    ): Promise<GitHistoryResult> => ipcRenderer.invoke('git:history', args),
    conflictOperation: (args: { worktreePath: string; connectionId?: string }): Promise<unknown> =>
      ipcRenderer.invoke('git:conflictOperation', args),
    abortMerge: (args: { worktreePath: string; connectionId?: string }): Promise<void> =>
      ipcRenderer.invoke('git:abortMerge', args),
    abortRebase: (args: { worktreePath: string; connectionId?: string }): Promise<void> =>
      ipcRenderer.invoke('git:abortRebase', args),
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
    commitCompare: (args: {
      worktreePath: string
      commitId: string
      connectionId?: string
    }): Promise<unknown> => ipcRenderer.invoke('git:commitCompare', args),
    upstreamStatus: (args: {
      worktreePath: string
      connectionId?: string
      pushTarget?: GitPushTarget
    }): Promise<GitUpstreamStatus> => ipcRenderer.invoke('git:upstreamStatus', args),
    fetch: (args: {
      worktreePath: string
      connectionId?: string
      pushTarget?: GitPushTarget
    }): Promise<void> => ipcRenderer.invoke('git:fetch', args),
    syncFork: (args: {
      worktreePath: string
      connectionId?: string
      expectedUpstream: GitForkSyncExpectedUpstream
    }): Promise<GitForkSyncResult> => ipcRenderer.invoke('git:syncFork', args),
    push: (args: {
      worktreePath: string
      publish?: boolean
      forceWithLease?: boolean
      connectionId?: string
      pushTarget?: unknown
    }): Promise<void> => ipcRenderer.invoke('git:push', args),
    pull: (args: {
      worktreePath: string
      connectionId?: string
      pushTarget?: GitPushTarget
    }): Promise<void> => ipcRenderer.invoke('git:pull', args),
    fastForward: (args: {
      worktreePath: string
      connectionId?: string
      pushTarget?: GitPushTarget
    }): Promise<void> => ipcRenderer.invoke('git:fastForward', args),
    rebaseFromBase: (args: {
      worktreePath: string
      baseRef: string
      connectionId?: string
    }): Promise<void> => ipcRenderer.invoke('git:rebaseFromBase', args),
    branchDiff: (args: {
      worktreePath: string
      compare: { baseRef: string; baseOid: string; headOid: string; mergeBase: string }
      filePath: string
      oldPath?: string
      connectionId?: string
    }): Promise<unknown> => ipcRenderer.invoke('git:branchDiff', args),
    commitDiff: (args: {
      worktreePath: string
      commitOid: string
      parentOid?: string | null
      filePath: string
      oldPath?: string
      connectionId?: string
    }): Promise<unknown> => ipcRenderer.invoke('git:commitDiff', args),
    commit: (args: {
      worktreePath: string
      message: string
      connectionId?: string
    }): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('git:commit', args),
    generateCommitMessage: (args: {
      worktreePath: string
      repoId?: string
      connectionId?: string
      sourceControlAiResolvedParams?: unknown
      sourceControlAi?: unknown
      agentCmdOverrides?: Record<string, string>
    }): Promise<unknown> => ipcRenderer.invoke('git:generateCommitMessage', args),
    discoverCommitMessageModels: (args: {
      agentId: string
      worktreePath?: string
      connectionId?: string
    }): Promise<unknown> => ipcRenderer.invoke('git:discoverCommitMessageModels', args),
    cancelGenerateCommitMessage: (args: {
      worktreePath: string
      connectionId?: string
    }): Promise<void> => ipcRenderer.invoke('git:cancelGenerateCommitMessage', args),
    generatePullRequestFields: (args: {
      worktreePath: string
      repoId?: string
      base: string
      title: string
      body: string
      draft: boolean
      provider?: unknown
      useTemplate?: boolean
      connectionId?: string
      sourceControlAiResolvedParams?: unknown
      sourceControlAi?: unknown
      agentCmdOverrides?: Record<string, string>
    }): Promise<unknown> => ipcRenderer.invoke('git:generatePullRequestFields', args),
    cancelGeneratePullRequestFields: (args: {
      worktreePath: string
      connectionId?: string
    }): Promise<void> => ipcRenderer.invoke('git:cancelGeneratePullRequestFields', args),
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
    bulkDiscard: (args: {
      worktreePath: string
      filePaths: string[]
      connectionId?: string
    }): Promise<void> => ipcRenderer.invoke('git:bulkDiscard', args),
    remoteFileUrl: (args: {
      worktreePath: string
      relativePath: string
      line: number
      connectionId?: string
    }): Promise<string | null> => ipcRenderer.invoke('git:remoteFileUrl', args),
    remoteCommitUrl: (args: {
      worktreePath: string
      sha: string
      connectionId?: string
    }): Promise<string | null> => ipcRenderer.invoke('git:remoteCommitUrl', args)
  },

  ui: {
    get: () => ipcRenderer.invoke('ui:get'),
    set: (args) => ipcRenderer.invoke('ui:set', args),
    recordFeatureInteraction: (id) => ipcRenderer.invoke('ui:recordFeatureInteraction', id),
    onStateChanged: (callback: (ui: PersistedUIState) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, ui: PersistedUIState): void =>
        callback(ui)
      ipcRenderer.on('ui:stateChanged', listener)
      return () => ipcRenderer.removeListener('ui:stateChanged', listener)
    },
    onOpenSettings: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:openSettings', listener)
      return () => ipcRenderer.removeListener('ui:openSettings', listener)
    },
    onOpenSetupGuide: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:openSetupGuide', listener)
      return () => ipcRenderer.removeListener('ui:openSetupGuide', listener)
    },
    onOpenFeatureTour: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:openFeatureTour', listener)
      return () => ipcRenderer.removeListener('ui:openFeatureTour', listener)
    },
    onOpenCrashReport: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:openCrashReport', listener)
      return () => ipcRenderer.removeListener('ui:openCrashReport', listener)
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
    onToggleFloatingTerminal: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:toggleFloatingTerminal', listener)
      return () => ipcRenderer.removeListener('ui:toggleFloatingTerminal', listener)
    },
    onTerminalShortcutCaptured: (
      callback: (data: { actionId: KeybindingActionId }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { actionId: KeybindingActionId }
      ) => callback(data)
      ipcRenderer.on('ui:terminalShortcutCaptured', listener)
      return () => ipcRenderer.removeListener('ui:terminalShortcutCaptured', listener)
    },
    onOpenQuickOpen: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:openQuickOpen', listener)
      return () => ipcRenderer.removeListener('ui:openQuickOpen', listener)
    },
    onToggleQuickCommandsMenu: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:toggleQuickCommandsMenu', listener)
      return () => ipcRenderer.removeListener('ui:toggleQuickCommandsMenu', listener)
    },
    onOpenNewWorkspace: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:openNewWorkspace', listener)
      return () => ipcRenderer.removeListener('ui:openNewWorkspace', listener)
    },
    onDeleteCurrentWorkspace: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:deleteCurrentWorkspace', listener)
      return () => ipcRenderer.removeListener('ui:deleteCurrentWorkspace', listener)
    },
    onOpenWorkspaceBoard: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:openWorkspaceBoard', listener)
      return () => ipcRenderer.removeListener('ui:openWorkspaceBoard', listener)
    },
    onOpenTasks: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:openTasks', listener)
      return () => ipcRenderer.removeListener('ui:openTasks', listener)
    },
    onJumpToWorktreeIndex: (callback: (index: number) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, index: number) => callback(index)
      ipcRenderer.on('ui:jumpToWorktreeIndex', listener)
      return () => ipcRenderer.removeListener('ui:jumpToWorktreeIndex', listener)
    },
    onJumpToTabIndex: (callback: (index: number) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, index: number) => callback(index)
      ipcRenderer.on('ui:jumpToTabIndex', listener)
      return () => ipcRenderer.removeListener('ui:jumpToTabIndex', listener)
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
    onNewMarkdownTab: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:newMarkdownTab', listener)
      return () => ipcRenderer.removeListener('ui:newMarkdownTab', listener)
    },
    onNewSimulatorTab: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:newSimulatorTab', listener)
      return () => ipcRenderer.removeListener('ui:newSimulatorTab', listener)
    },
    onRequestTabCreate: (
      callback: (data: {
        requestId: string
        url: string
        worktreeId?: string
        sessionProfileId?: string | null
        sessionPartition?: string
        activate?: boolean
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          requestId: string
          url: string
          worktreeId?: string
          sessionProfileId?: string | null
          sessionPartition?: string
          activate?: boolean
        }
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
      callback: (data: {
        requestId: string
        browserPageId: string
        profileId: string
        sessionPartition?: string
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          requestId: string
          browserPageId: string
          profileId: string
          sessionPartition?: string
        }
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
    onBrowserHistoryNavigate: (callback: (direction: 'back' | 'forward') => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, direction: 'back' | 'forward'): void =>
        callback(direction)
      ipcRenderer.on('ui:browserHistoryNavigate', listener)
      return () => ipcRenderer.removeListener('ui:browserHistoryNavigate', listener)
    },
    onZoomBrowserPage: (callback: (direction: 'in' | 'out' | 'reset') => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, direction: 'in' | 'out' | 'reset') =>
        callback(direction)
      ipcRenderer.on('ui:zoomBrowserPage', listener)
      return () => ipcRenderer.removeListener('ui:zoomBrowserPage', listener)
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
    onSwitchRecentTab: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:switchRecentTab', listener)
      return () => ipcRenderer.removeListener('ui:switchRecentTab', listener)
    },
    onSwitchTerminalTab: (callback: (direction: 1 | -1) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, direction: 1 | -1) => callback(direction)
      ipcRenderer.on('ui:switchTerminalTab', listener)
      return () => ipcRenderer.removeListener('ui:switchTerminalTab', listener)
    },
    onCtrlTabKeyDown: (callback: (data: { shiftKey: boolean }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { shiftKey: boolean }) =>
        callback(data)
      ipcRenderer.on('ui:ctrlTabKeyDown', listener)
      return () => ipcRenderer.removeListener('ui:ctrlTabKeyDown', listener)
    },
    onCtrlTabKeyUp: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:ctrlTabKeyUp', listener)
      return () => ipcRenderer.removeListener('ui:ctrlTabKeyUp', listener)
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
    onAppMenuPaste: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:appMenuPaste', listener)
      return () => ipcRenderer.removeListener('ui:appMenuPaste', listener)
    },
    onEditableContextPaste: (
      callback: (data: { plainTextOnly: boolean }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { plainTextOnly: boolean }
      ): void => callback({ plainTextOnly: data?.plainTextOnly === true })
      ipcRenderer.on('ui:editableContextPaste', listener)
      return () => ipcRenderer.removeListener('ui:editableContextPaste', listener)
    },
    onDictationKeyDown: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('ui:dictationKeyDown', listener)
      return () => ipcRenderer.removeListener('ui:dictationKeyDown', listener)
    },
    onActivateWorktree: (
      callback: (data: {
        repoId: string
        worktreeId: string
        setup?: { runnerScriptPath: string; envVars: Record<string, string> }
        startup?: { command: string; env?: Record<string, string> }
        defaultTabs?: WorktreeDefaultTabsLaunch
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          repoId: string
          worktreeId: string
          setup?: { runnerScriptPath: string; envVars: Record<string, string> }
          startup?: { command: string; env?: Record<string, string> }
          defaultTabs?: WorktreeDefaultTabsLaunch
        }
      ) => callback(data)
      ipcRenderer.on('ui:activateWorktree', listener)
      return () => ipcRenderer.removeListener('ui:activateWorktree', listener)
    },
    onCreateTerminal: (
      callback: (data: {
        requestId?: string
        worktreeId: string
        command?: string
        cwd?: string
        env?: Record<string, string>
        launchConfig?: SleepingAgentLaunchConfig
        launchToken?: string
        launchAgent?: TuiAgent
        title?: string
        ptyId?: string
        activate?: boolean
        presentation?: RuntimeTerminalPresentation
        tabId?: string
        leafId?: string
        splitFromLeafId?: string
        splitDirection?: 'horizontal' | 'vertical'
        splitTelemetrySource?: TerminalPaneSplitSource
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          requestId?: string
          worktreeId: string
          command?: string
          cwd?: string
          env?: Record<string, string>
          launchConfig?: SleepingAgentLaunchConfig
          launchToken?: string
          launchAgent?: TuiAgent
          title?: string
          ptyId?: string
          activate?: boolean
          presentation?: RuntimeTerminalPresentation
          tabId?: string
          leafId?: string
          splitFromLeafId?: string
          splitDirection?: 'horizontal' | 'vertical'
          splitTelemetrySource?: TerminalPaneSplitSource
        }
      ) => callback(data)
      ipcRenderer.on('ui:createTerminal', listener)
      return () => ipcRenderer.removeListener('ui:createTerminal', listener)
    },
    onRequestTerminalCreate: (
      callback: (data: RuntimeTerminalCreateRequestPayload) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: RuntimeTerminalCreateRequestPayload
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
        telemetrySource?: TerminalPaneSplitSource
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          tabId: string
          paneRuntimeId: number
          direction: 'horizontal' | 'vertical'
          command?: string
          telemetrySource?: TerminalPaneSplitSource
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
      callback: (data: {
        tabId: string
        worktreeId: string
        leafId?: string | null
        ackPaneKeyOnSuccess?: string
        flashFocusedPane?: boolean
        scrollToBottomIfOutputSinceLastView?: boolean
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          tabId: string
          worktreeId: string
          leafId?: string | null
          ackPaneKeyOnSuccess?: string
          flashFocusedPane?: boolean
          scrollToBottomIfOutputSinceLastView?: boolean
        }
      ) => callback(data)
      ipcRenderer.on('ui:focusTerminal', listener)
      return () => ipcRenderer.removeListener('ui:focusTerminal', listener)
    },
    onFocusEditorTab: (
      callback: (data: { tabId: string; worktreeId: string }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { tabId: string; worktreeId: string }
      ) => callback(data)
      ipcRenderer.on('ui:focusEditorTab', listener)
      return () => ipcRenderer.removeListener('ui:focusEditorTab', listener)
    },
    onCloseSessionTab: (
      callback: (data: { tabId: string; worktreeId: string }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { tabId: string; worktreeId: string }
      ) => callback(data)
      ipcRenderer.on('ui:closeSessionTab', listener)
      return () => ipcRenderer.removeListener('ui:closeSessionTab', listener)
    },
    onMoveSessionTab: (
      callback: (data: { worktreeId: string } & RuntimeMobileSessionTabMove) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { worktreeId: string } & RuntimeMobileSessionTabMove
      ) => callback(data)
      ipcRenderer.on('ui:moveSessionTab', listener)
      return () => ipcRenderer.removeListener('ui:moveSessionTab', listener)
    },
    onOpenFileFromMobile: (
      callback: (data: {
        worktreeId: string
        filePath: string
        relativePath: string
        runtimeEnvironmentId?: string
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          worktreeId: string
          filePath: string
          relativePath: string
          runtimeEnvironmentId?: string
        }
      ) => callback(data)
      ipcRenderer.on('ui:openFileFromMobile', listener)
      return () => ipcRenderer.removeListener('ui:openFileFromMobile', listener)
    },
    onOpenDiffFromMobile: (
      callback: (data: {
        worktreeId: string
        filePath: string
        relativePath: string
        staged: boolean
        runtimeEnvironmentId?: string
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          worktreeId: string
          filePath: string
          relativePath: string
          staged: boolean
          runtimeEnvironmentId?: string
        }
      ) => callback(data)
      ipcRenderer.on('ui:openDiffFromMobile', listener)
      return () => ipcRenderer.removeListener('ui:openDiffFromMobile', listener)
    },
    onMobileMarkdownRequest: (
      callback: (request: RuntimeMobileMarkdownRequest) => void
    ): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, request: RuntimeMobileMarkdownRequest) =>
        callback(request)
      ipcRenderer.on('ui:mobileMarkdownRequest', listener)
      return () => ipcRenderer.removeListener('ui:mobileMarkdownRequest', listener)
    },
    respondMobileMarkdownRequest: (response: RuntimeMobileMarkdownResponse): void => {
      ipcRenderer.send('ui:mobileMarkdownResponse', response)
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
    onResumeSleepingAgents: (callback: (data: { worktreeId: string }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { worktreeId: string }) =>
        callback(data)
      ipcRenderer.on('ui:resumeSleepingAgents', listener)
      return () => ipcRenderer.removeListener('ui:resumeSleepingAgents', listener)
    },
    onTerminalZoom: (callback: (direction: 'in' | 'out' | 'reset') => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, direction: 'in' | 'out' | 'reset') =>
        callback(direction)
      ipcRenderer.on('terminal:zoom', listener)
      return () => ipcRenderer.removeListener('terminal:zoom', listener)
    },
    readClipboardText: (options?: ReadClipboardTextOptions): Promise<string> =>
      ipcRenderer.invoke('clipboard:readText', options),
    readSelectionClipboardText: (options?: ReadClipboardTextOptions): Promise<string> =>
      ipcRenderer.invoke('clipboard:readSelectionText', options),
    saveClipboardImageAsTempFile: (args?: {
      connectionId?: string | null
      runtimeEnvironmentId?: string | null
    }): Promise<string | null> => ipcRenderer.invoke('clipboard:saveImageAsTempFile', args),
    writeClipboardText: (text: string): Promise<void> =>
      ipcRenderer.invoke('clipboard:writeText', text),
    writeSelectionClipboardText: (text: string): Promise<void> =>
      ipcRenderer.invoke('clipboard:writeSelectionText', text),
    writeClipboardImage: (dataUrl: string): Promise<void> =>
      ipcRenderer.invoke('clipboard:writeImage', dataUrl),
    performNativePaste: (options?: { mode?: 'paste' | 'paste-and-match-style' }): void => {
      ipcRenderer.send('ui:performNativePaste', {
        mode: options?.mode === 'paste-and-match-style' ? 'paste-and-match-style' : 'paste'
      })
    },
    writeClipboardFile: (
      args:
        | {
            filePath: string
            connectionId?: string | null
          }
        | string
    ): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke('clipboard:writeFile', args),
    onFileDrop: (callback: (data: NativeFileDropPayload) => void): (() => void) =>
      subscribeNativeFileDrop(callback),
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
    setTerminalInputFocused: (focused: boolean): void => {
      ipcRenderer.send('ui:setTerminalInputFocused', focused)
    },
    setFloatingTerminalInputFocused: (focused: boolean): void => {
      ipcRenderer.send('ui:setFloatingTerminalInputFocused', focused)
    },
    setShortcutRecorderFocused: (focused: boolean): void => {
      ipcRenderer.send('ui:setShortcutRecorderFocused', focused)
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
    /** Fired when the OS resumes from sleep (main relays powerMonitor). A
     *  focus-preserving display wake fires no renderer focus/visibility
     *  events, so terminal wake recovery listens to this explicit signal. */
    onSystemResumed: (callback: () => void): (() => void) => {
      const listener = () => callback()
      ipcRenderer.on('system:resumed', listener)
      return () => ipcRenderer.removeListener('system:resumed', listener)
    },
    /** Desktop custom titlebar only: minimize via renderer-drawn window controls. */
    minimize: (): void => {
      ipcRenderer.send('window:minimize')
    },
    /** Desktop custom titlebar only: toggle maximize/restore via renderer-drawn controls. */
    maximize: (): void => {
      ipcRenderer.send('window:maximize')
    },
    /** Desktop custom titlebar only: read the current maximize state on mount, since
     *  window:maximize-changed only fires on transitions and a window that
     *  starts maximized would otherwise show the wrong icon. */
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:isMaximized'),
    /** Desktop custom titlebar only: subscribe to maximize state changes so the renderer-drawn
     *  maximize button can show the correct restore/maximize icon. */
    onMaximizeChanged: (callback: (isMaximized: boolean) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, isMaximized: boolean) =>
        callback(isMaximized)
      ipcRenderer.on('window:maximize-changed', listener)
      return () => ipcRenderer.removeListener('window:maximize-changed', listener)
    },
    /** Desktop custom titlebar only: request a close from the renderer-drawn close button.
     *  Routes through main so the BrowserWindow 'close' event fires and the
     *  terminal-running confirmation guard in the renderer stays active.
     *  window.close() is unreliable in sandboxed renderers. */
    requestClose: (): void => {
      ipcRenderer.send('window:request-close')
    },
    /** Desktop custom titlebar only: pop up the application menu at the cursor position.
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
  } satisfies PreloadApi['ui'],

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
    getSnapshot: (args: { scope: string; range: string; limit?: number }): Promise<unknown> =>
      ipcRenderer.invoke('claudeUsage:getSnapshot', args),
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
    getSnapshot: (args: { scope: string; range: string; limit?: number }): Promise<unknown> =>
      ipcRenderer.invoke('codexUsage:getSnapshot', args),
    getSummary: (args: { scope: string; range: string }): Promise<unknown> =>
      ipcRenderer.invoke('codexUsage:getSummary', args),
    getDaily: (args: { scope: string; range: string }): Promise<unknown> =>
      ipcRenderer.invoke('codexUsage:getDaily', args),
    getBreakdown: (args: { scope: string; range: string; kind: string }): Promise<unknown> =>
      ipcRenderer.invoke('codexUsage:getBreakdown', args),
    getRecentSessions: (args: { scope: string; range: string; limit?: number }): Promise<unknown> =>
      ipcRenderer.invoke('codexUsage:getRecentSessions', args)
  },

  openCodeUsage: {
    getScanState: (): Promise<unknown> => ipcRenderer.invoke('openCodeUsage:getScanState'),
    setEnabled: (args: { enabled: boolean }): Promise<unknown> =>
      ipcRenderer.invoke('openCodeUsage:setEnabled', args),
    refresh: (args?: { force?: boolean }): Promise<unknown> =>
      ipcRenderer.invoke('openCodeUsage:refresh', args),
    getSnapshot: (args: { scope: string; range: string; limit?: number }): Promise<unknown> =>
      ipcRenderer.invoke('openCodeUsage:getSnapshot', args),
    getSummary: (args: { scope: string; range: string }): Promise<unknown> =>
      ipcRenderer.invoke('openCodeUsage:getSummary', args),
    getDaily: (args: { scope: string; range: string }): Promise<unknown> =>
      ipcRenderer.invoke('openCodeUsage:getDaily', args),
    getBreakdown: (args: { scope: string; range: string; kind: string }): Promise<unknown> =>
      ipcRenderer.invoke('openCodeUsage:getBreakdown', args),
    getRecentSessions: (args: { scope: string; range: string; limit?: number }): Promise<unknown> =>
      ipcRenderer.invoke('openCodeUsage:getRecentSessions', args)
  },

  aiVault: {
    listSessions: (args?: AiVaultListArgs): Promise<unknown> =>
      ipcRenderer.invoke('aiVault:listSessions', args),
    listSubagentSessions: (args: AiVaultSubagentListArgs): Promise<unknown> =>
      ipcRenderer.invoke('aiVault:listSubagentSessions', args),
    onWindowFocused: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('aiVault:windowFocused', listener)
      return () => ipcRenderer.removeListener('aiVault:windowFocused', listener)
    }
  },

  nativeChat: {
    readSession: (
      agent: AgentType,
      sessionId: string,
      limit?: number,
      transcriptPath?: string
    ): Promise<NativeChatReadSessionResult> =>
      ipcRenderer.invoke('nativeChat:readSession', { agent, sessionId, limit, transcriptPath }),
    /** Start live tailing for a transcript. `onAppended` fires with only the
     *  newly-appended messages. Returns an unsubscribe fn that closes the
     *  main-process watcher (subscriptionId routes appends to this caller). */
    subscribe: (
      args: {
        subscriptionId: string
        agent: AgentType
        sessionId: string
        transcriptPath?: string
      },
      onAppended: (messages: NativeChatAppendedMessages) => void
    ): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: NativeChatAppendedPayload) => {
        if (payload.subscriptionId === args.subscriptionId) {
          onAppended(payload.messages)
        }
      }
      ipcRenderer.on('nativeChat:appended', listener)
      ipcRenderer.send('nativeChat:subscribe', args)
      return () => {
        ipcRenderer.removeListener('nativeChat:appended', listener)
        ipcRenderer.send('nativeChat:unsubscribe', { subscriptionId: args.subscriptionId })
      }
    }
  },

  runtime: {
    syncWindowGraph: (graph: RuntimeSyncWindowGraph): Promise<RuntimeSyncWindowGraphResult> =>
      ipcRenderer.invoke('runtime:syncWindowGraph', graph),
    getStatus: (): Promise<RuntimeStatus> => ipcRenderer.invoke('runtime:getStatus'),
    call: (args: { method: string; params?: unknown }): Promise<RuntimeRpcResponse<unknown>> =>
      ipcRenderer.invoke('runtime:call', args),
    getTerminalFitOverrides: (): Promise<
      { ptyId: string; mode: 'mobile-fit'; cols: number; rows: number }[]
    > => ipcRenderer.invoke('runtime:getTerminalFitOverrides'),
    getTerminalDrivers: (): Promise<
      {
        ptyId: string
        driver: RuntimeTerminalDriverState
      }[]
    > => ipcRenderer.invoke('runtime:getTerminalDrivers'),
    getBrowserDrivers: (): Promise<
      {
        browserPageId: string
        driver: RuntimeBrowserDriverState
      }[]
    > => ipcRenderer.invoke('runtime:getBrowserDrivers'),
    restoreTerminalFit: (ptyId: string): Promise<{ restored: boolean }> =>
      ipcRenderer.invoke('runtime:restoreTerminalFit', { ptyId }),
    reclaimBrowserForDesktop: (browserPageId: string): Promise<{ reclaimed: boolean }> =>
      ipcRenderer.invoke('runtime:reclaimBrowserForDesktop', { browserPageId }),
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
      callback: (event: { ptyId: string; driver: RuntimeTerminalDriverState }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          ptyId: string
          driver: RuntimeTerminalDriverState
        }
      ) => callback(data)
      ipcRenderer.on('runtime:terminalDriverChanged', listener)
      return () => ipcRenderer.removeListener('runtime:terminalDriverChanged', listener)
    },
    onBrowserDriverChanged: (
      callback: (event: { browserPageId: string; driver: RuntimeBrowserDriverState }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          browserPageId: string
          driver: RuntimeBrowserDriverState
        }
      ) => callback(data)
      ipcRenderer.on('runtime:browserDriverChanged', listener)
      return () => ipcRenderer.removeListener('runtime:browserDriverChanged', listener)
    }
  },

  runtimeEnvironments: {
    list: (): Promise<PublicKnownRuntimeEnvironment[]> =>
      ipcRenderer.invoke('runtimeEnvironments:list'),
    addFromPairingCode: (args: {
      name: string
      pairingCode: string
    }): Promise<{ environment: PublicKnownRuntimeEnvironment }> =>
      ipcRenderer.invoke('runtimeEnvironments:addFromPairingCode', args),
    resolve: (args: { selector: string }): Promise<PublicKnownRuntimeEnvironment> =>
      ipcRenderer.invoke('runtimeEnvironments:resolve', args),
    remove: (args: { selector: string }): Promise<{ removed: PublicKnownRuntimeEnvironment }> =>
      ipcRenderer.invoke('runtimeEnvironments:remove', args),
    disconnect: (args: {
      selector: string
    }): Promise<{ disconnected: PublicKnownRuntimeEnvironment }> =>
      ipcRenderer.invoke('runtimeEnvironments:disconnect', args),
    getStatus: (args: {
      selector: string
      timeoutMs?: number
    }): Promise<RuntimeRpcResponse<RuntimeStatus>> =>
      ipcRenderer.invoke('runtimeEnvironments:getStatus', args),
    call: (args: {
      selector: string
      method: string
      params?: unknown
      timeoutMs?: number
    }): Promise<RuntimeRpcResponse<unknown>> =>
      ipcRenderer.invoke('runtimeEnvironments:call', args),
    subscribe: async (
      args: {
        selector: string
        method: string
        params?: unknown
        timeoutMs?: number
      },
      callbacks: {
        onResponse: (response: RuntimeRpcResponse<unknown>) => void
        onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
        onError?: (error: { code: string; message: string }) => void
        onClose?: () => void
      }
    ): Promise<RuntimeEnvironmentSubscriptionHandle> =>
      subscribeRuntimeEnvironmentFromPreload(ipcRenderer, args, callbacks)
  },

  rateLimits: {
    get: (): Promise<RateLimitState> => ipcRenderer.invoke('rateLimits:get'),
    refresh: (): Promise<RateLimitState> => ipcRenderer.invoke('rateLimits:refresh'),
    refreshCodexForTarget: (target: RateLimitRuntimeTarget): Promise<RateLimitState> =>
      ipcRenderer.invoke('rateLimits:refreshCodexForTarget', target),
    consumeCodexResetCredit: (): Promise<CodexRateLimitResetResult> =>
      ipcRenderer.invoke('rateLimits:consumeCodexResetCredit'),
    refreshClaudeForTarget: (target: RateLimitRuntimeTarget): Promise<RateLimitState> =>
      ipcRenderer.invoke('rateLimits:refreshClaudeForTarget', target),
    setPollingInterval: (ms: number): Promise<void> =>
      ipcRenderer.invoke('rateLimits:setPollingInterval', ms),
    fetchInactiveClaudeAccounts: (): Promise<void> =>
      ipcRenderer.invoke('rateLimits:fetchInactiveClaudeAccounts'),
    fetchInactiveCodexAccounts: (): Promise<void> =>
      ipcRenderer.invoke('rateLimits:fetchInactiveCodexAccounts'),
    refreshMiniMax: (): Promise<RateLimitState> => ipcRenderer.invoke('rateLimits:refreshMiniMax'),
    refreshGrok: (): Promise<RateLimitState> => ipcRenderer.invoke('rateLimits:refreshGrok'),
    onUpdate: (callback: (state: RateLimitState) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: RateLimitState) => callback(state)
      ipcRenderer.on('rateLimits:update', listener)
      return () => ipcRenderer.removeListener('rateLimits:update', listener)
    }
  },

  minimaxCredentials: {
    getStatus: (): Promise<{ configured: boolean }> =>
      ipcRenderer.invoke('minimaxCredentials:getStatus'),
    saveCookie: (cookie: string): Promise<{ configured: boolean }> =>
      ipcRenderer.invoke('minimaxCredentials:saveCookie', cookie),
    clearCookie: (): Promise<{ configured: boolean }> =>
      ipcRenderer.invoke('minimaxCredentials:clearCookie')
  },

  grokAccounts: {
    getStatus: (): Promise<GrokAccountStatus> => ipcRenderer.invoke('grokAccounts:getStatus')
  },

  ssh: {
    listTargets: (): Promise<SshTarget[]> => ipcRenderer.invoke('ssh:listTargets'),

    listRemovedTargetLabels: (): Promise<Record<string, string>> =>
      ipcRenderer.invoke('ssh:listRemovedTargetLabels'),

    addTarget: (args: { target: Omit<SshTarget, 'id'> }): Promise<SshTarget> =>
      ipcRenderer.invoke('ssh:addTarget', args),

    updateTarget: (args: {
      id: string
      updates: Partial<Omit<SshTarget, 'id'>>
    }): Promise<SshTarget> => ipcRenderer.invoke('ssh:updateTarget', args),

    removeTarget: (args: { id: string }): Promise<void> =>
      ipcRenderer.invoke('ssh:removeTarget', args),

    importConfig: (args?: { reAdopt?: boolean }): Promise<SshTarget[]> =>
      ipcRenderer.invoke('ssh:importConfig', args),

    connect: (args: { targetId: string }): Promise<SshConnectionState | null> =>
      ipcRenderer.invoke('ssh:connect', args),

    disconnect: (args: { targetId: string }): Promise<void> =>
      ipcRenderer.invoke('ssh:disconnect', args),

    terminateSessions: (args: { targetId: string }): Promise<void> =>
      ipcRenderer.invoke('ssh:terminateSessions', args),

    resetRelay: (args: { targetId: string }): Promise<void> =>
      ipcRenderer.invoke('ssh:resetRelay', args),

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

    listDetectedPorts: (args: { targetId: string }): Promise<EnrichedDetectedPort[]> =>
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
      callback: (data: { targetId: string; ports: EnrichedDetectedPort[] }) => void
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: { targetId: string; ports: EnrichedDetectedPort[] }
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

  automations: {
    list: (): Promise<Automation[]> => ipcRenderer.invoke('automations:list'),
    listRuns: (args?: { automationId?: string }): Promise<AutomationRun[]> =>
      ipcRenderer.invoke('automations:listRuns', args),
    listExternalManagers: (): Promise<ExternalAutomationManager[]> =>
      ipcRenderer.invoke('automations:listExternalManagers'),
    listExternalRuns: (input: ExternalAutomationRunsInput): Promise<ExternalAutomationRunsPage> =>
      ipcRenderer.invoke('automations:listExternalRuns', input),
    createExternal: (input: ExternalAutomationCreateInput): Promise<void> =>
      ipcRenderer.invoke('automations:createExternal', input),
    updateExternal: (input: ExternalAutomationUpdateInput): Promise<void> =>
      ipcRenderer.invoke('automations:updateExternal', input),
    runExternalAction: (input: ExternalAutomationActionInput): Promise<void> =>
      ipcRenderer.invoke('automations:runExternalAction', input),
    create: (input: AutomationCreateInput): Promise<Automation> =>
      ipcRenderer.invoke('automations:create', input),
    update: (args: { id: string; updates: AutomationUpdateInput }): Promise<Automation> =>
      ipcRenderer.invoke('automations:update', args),
    delete: (args: { id: string }): Promise<void> => ipcRenderer.invoke('automations:delete', args),
    runNow: (args: { id: string }): Promise<AutomationRun> =>
      ipcRenderer.invoke('automations:runNow', args),
    runPrecheck: (args: {
      automationId: string
      runId: string
    }): Promise<AutomationPrecheckResult | null> =>
      ipcRenderer.invoke('automations:runPrecheck', args),
    markDispatchResult: (result: AutomationDispatchResult): Promise<AutomationRun> =>
      ipcRenderer.invoke('automations:markDispatchResult', result),
    snapshotWorkspaceName: (args: { workspaceId: string; displayName: string }): Promise<number> =>
      ipcRenderer.invoke('automations:snapshotWorkspaceName', args),
    rendererReady: (): Promise<void> => ipcRenderer.invoke('automations:rendererReady'),
    onDispatchRequested: (callback: (request: AutomationDispatchRequest) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, request: AutomationDispatchRequest) =>
        callback(request)
      ipcRenderer.on('automations:dispatchRequested', listener)
      return () => ipcRenderer.removeListener('automations:dispatchRequested', listener)
    }
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

    getRuntimePairingUrl: (args?: {
      address?: string
      rotate?: boolean
    }): Promise<
      | { available: false }
      | {
          available: true
          pairingUrl: string
          webClientUrl: string | null
          endpoint: string
          deviceId: string
        }
    > => ipcRenderer.invoke('mobile:getRuntimePairingUrl', args),

    listDevices: (): Promise<{
      devices: { deviceId: string; name: string; pairedAt: number; lastSeenAt: number }[]
    }> => ipcRenderer.invoke('mobile:listDevices'),

    revokeDevice: (args: { deviceId: string }): Promise<{ revoked: boolean }> =>
      ipcRenderer.invoke('mobile:revokeDevice', args),

    listRuntimeAccessGrants: () => ipcRenderer.invoke('mobile:listRuntimeAccessGrants'),

    revokeRuntimeAccess: (args: { deviceId: string }): Promise<{ revoked: boolean }> =>
      ipcRenderer.invoke('mobile:revokeRuntimeAccess', args),

    isWebSocketReady: (): Promise<{ ready: boolean; endpoint: string | null }> =>
      ipcRenderer.invoke('mobile:isWebSocketReady')
  },

  agentStatus: {
    /** Listen for agent status updates forwarded from native hook receivers. */
    onSet: (callback: (data: AgentStatusIpcPayload) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: AgentStatusIpcPayload) =>
        callback(data)
      ipcRenderer.on('agentStatus:set', listener)
      return () => ipcRenderer.removeListener('agentStatus:set', listener)
    },
    onClear: (callback: (data: { paneKey: string }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { paneKey: string }) =>
        callback(data)
      ipcRenderer.on('agentStatus:clear', listener)
      return () => ipcRenderer.removeListener('agentStatus:clear', listener)
    },
    /** Pull the current cached hook statuses after renderer workspace-session
     *  hydration. This avoids losing startup replays before the renderer
     *  knows which tabs exist. */
    getSnapshot: (): Promise<AgentStatusIpcPayload[]> =>
      ipcRenderer.invoke('agentStatus:getSnapshot'),
    inferInterrupt: (request: AgentInterruptInferenceRequest): Promise<boolean> =>
      ipcRenderer.invoke('agentStatus:inferInterrupt', request),
    onMigrationUnsupported: (
      callback: (entry: MigrationUnsupportedPtyEntry) => void
    ): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, entry: MigrationUnsupportedPtyEntry) =>
        callback(entry)
      ipcRenderer.on('agentStatus:migrationUnsupported', listener)
      return () => ipcRenderer.removeListener('agentStatus:migrationUnsupported', listener)
    },
    onMigrationUnsupportedClear: (callback: (data: { ptyId: string }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { ptyId: string }) =>
        callback(data)
      ipcRenderer.on('agentStatus:migrationUnsupportedClear', listener)
      return () => ipcRenderer.removeListener('agentStatus:migrationUnsupportedClear', listener)
    },
    getMigrationUnsupportedSnapshot: (): Promise<MigrationUnsupportedPtyEntry[]> =>
      ipcRenderer.invoke('agentStatus:getMigrationUnsupportedSnapshot'),
    /** Drop the cached hook status for a paneKey on both sides — main-process
     *  cache (lastStatusByPaneKey) and on-disk last-status file. Fired from
     *  the renderer when the user dismisses a retained row so a relaunch
     *  cannot resurrect it. Fire-and-forget; no response. */
    drop: (paneKey: string): void => {
      ipcRenderer.send('agentStatus:drop', paneKey)
    },
    /** Drop all cached hook statuses under one terminal tab prefix. Fired on
     *  explicit tab close even when the renderer has no matching local row. */
    dropByTabPrefix: (tabId: string): void => {
      ipcRenderer.send('agentStatus:dropByTabPrefix', tabId)
    }
  },

  speech: {
    getCatalog: (): Promise<SpeechModelManifest[]> => ipcRenderer.invoke('speech:getCatalog'),
    getModelStates: (): Promise<SpeechModelState[]> => ipcRenderer.invoke('speech:getModelStates'),
    getOpenAiApiKeyStatus: (): Promise<{ configured: boolean }> =>
      ipcRenderer.invoke('speech:getOpenAiApiKeyStatus'),
    saveOpenAiApiKey: (apiKey: string): Promise<{ configured: boolean }> =>
      ipcRenderer.invoke('speech:saveOpenAiApiKey', apiKey),
    clearOpenAiApiKey: (): Promise<{ configured: boolean }> =>
      ipcRenderer.invoke('speech:clearOpenAiApiKey'),
    downloadModel: (modelId: string): Promise<void> =>
      ipcRenderer.invoke('speech:downloadModel', modelId),
    cancelDownload: (modelId: string): Promise<void> =>
      ipcRenderer.invoke('speech:cancelDownload', modelId),
    deleteModel: (modelId: string): Promise<void> =>
      ipcRenderer.invoke('speech:deleteModel', modelId),
    startDictation: (
      modelId: string,
      hotwords: string[] | undefined,
      sessionId: string
    ): Promise<void> => ipcRenderer.invoke('speech:startDictation', modelId, hotwords, sessionId),
    feedAudio: (samples: Float32Array, sampleRate: number, sessionId = 'desktop'): Promise<void> =>
      // Why: Float32Array data gets zeroed out when crossing the contextBridge
      // + IPC boundary. Wrapping in a Buffer preserves the raw bytes reliably.
      ipcRenderer.invoke(
        'speech:feedAudio',
        Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength),
        sampleRate,
        sessionId
      ),
    stopDictation: (sessionId = 'desktop'): Promise<void> =>
      ipcRenderer.invoke('speech:stopDictation', sessionId),

    onPartialTranscript: (callback: (data: SpeechTranscriptEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: SpeechTranscriptEvent): void =>
        callback(data)
      ipcRenderer.on('speech:partial', listener)
      return () => ipcRenderer.removeListener('speech:partial', listener)
    },
    onFinalTranscript: (callback: (data: SpeechTranscriptEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: SpeechTranscriptEvent): void =>
        callback(data)
      ipcRenderer.on('speech:final', listener)
      return () => ipcRenderer.removeListener('speech:final', listener)
    },
    onDownloadProgress: (
      callback: (data: { modelId: string; progress: number }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { modelId: string; progress: number }
      ): void => callback(data)
      ipcRenderer.on('speech:downloadProgress', listener)
      return () => ipcRenderer.removeListener('speech:downloadProgress', listener)
    },
    onReady: (callback: (data: SpeechLifecycleEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: SpeechLifecycleEvent): void =>
        callback(data)
      ipcRenderer.on('speech:ready', listener)
      return () => ipcRenderer.removeListener('speech:ready', listener)
    },
    onStopped: (callback: (data: SpeechLifecycleEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: SpeechLifecycleEvent): void =>
        callback(data)
      ipcRenderer.on('speech:stopped', listener)
      return () => ipcRenderer.removeListener('speech:stopped', listener)
    },
    onError: (callback: (data: SpeechErrorEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: SpeechErrorEvent): void =>
        callback(data)
      ipcRenderer.on('speech:error', listener)
      return () => ipcRenderer.removeListener('speech:error', listener)
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
