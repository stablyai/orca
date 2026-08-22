import type { PersistedUIState } from '../../shared/persisted-ui-state-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type {
  WorktreeDefaultTabsLaunch,
  WorktreeSetupLaunch,
  WorktreeStartupLaunch
} from '../../shared/worktree/launch-types'
import type { FeatureInteractionId } from '../../shared/feature-interactions'
import type { KeybindingActionId } from '../../shared/keybindings'
import type { BrowserFindSource } from '../../shared/browser-find-source'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../shared/agent-session-resume'
import type { TerminalPaneSplitSource } from '../../shared/feature-education-telemetry'
import type {
  RuntimeMobileSessionTabMove,
  RuntimeTerminalCreateRequestPayload,
  RuntimeTerminalPresentation
} from '../../shared/runtime-types'
import type {
  RuntimeMobileMarkdownRequest,
  RuntimeMobileMarkdownResponse
} from '../../shared/mobile-markdown-document'
import type { TerminalTabCreateReply } from '../../shared/terminal-reveal-identity'
import type {
  TerminalTabCloseRequest,
  TerminalTabCloseResponse
} from '../../shared/terminal-tab-close'
import type {
  SessionTabCloseRequest,
  SessionTabCloseResponse
} from '../../shared/session-tab-close'

export type UiCommandEventApi = {
  get: () => Promise<PersistedUIState>
  set: (args: Partial<PersistedUIState>) => Promise<void>
  recordFeatureInteraction: (id: FeatureInteractionId) => Promise<PersistedUIState>
  onStateChanged: (callback: (ui: PersistedUIState) => void) => () => void
  onOpenSettings: (callback: () => void) => () => void
  /** Consumes a one-shot tray/menu-bar "open settings" intent queued before mount. */
  consumePendingOpenSettings: () => Promise<boolean>
  onOpenSkillShare: (callback: (shareId: string) => void) => () => void
  consumePendingSkillShare: () => Promise<string | null>
  onOpenSetupGuide: (callback: () => void) => () => void
  onOpenFeatureTour: (callback: () => void) => () => void
  onOpenCrashReport: (callback: () => void) => () => void
  onToggleLeftSidebar: (callback: () => void) => () => void
  onToggleRightSidebar: (callback: () => void) => () => void
  onToggleWorktreePalette: (callback: () => void) => () => void
  onToggleFloatingTerminal: (callback: () => void) => () => void
  onTerminalShortcutCaptured: (
    callback: (data: { actionId: KeybindingActionId }) => void
  ) => () => void
  onOpenQuickOpen: (callback: () => void) => () => void
  onToggleQuickCommandsMenu: (callback: () => void) => () => void
  onOpenNewWorkspace: (callback: () => void) => () => void
  onDeleteCurrentWorkspace: (callback: () => void) => () => void
  onOpenWorkspaceBoard: (callback: () => void) => () => void
  onOpenTasks: (callback: () => void) => () => void
  onToggleAgentDashboard: (callback: () => void) => () => void
  onJumpToWorktreeIndex: (callback: (index: number) => void) => () => void
  onJumpToTabIndex: (callback: (index: number) => void) => () => void
  onWorktreeHistoryNavigate: (callback: (direction: 'back' | 'forward') => void) => () => void
  onNewBrowserTab: (callback: () => void) => () => void
  onNewMarkdownTab: (callback: () => void) => () => void
  onNewSimulatorTab: (callback: () => void) => () => void
  onRequestTabCreate: (
    callback: (data: {
      requestId: string
      url: string
      worktreeId?: string
      browserPageId?: string
      sessionProfileId?: string | null
      sessionPartition?: string
      activate?: boolean
    }) => void
  ) => () => void
  replyTabCreate: (reply: { requestId: string; browserPageId?: string; error?: string }) => void
  onRequestTabSetProfile: (
    callback: (data: {
      requestId: string
      browserPageId: string
      profileId: string
      sessionPartition?: string
    }) => void
  ) => () => void
  replyTabSetProfile: (reply: { requestId: string; error?: string }) => void
  onRequestTabClose: (
    callback: (data: { requestId: string; tabId: string | null; worktreeId?: string }) => void
  ) => () => void
  replyTabClose: (reply: {
    requestId: string
    error?: string
    code?: 'browser_tab_not_found'
  }) => void
  onNewTerminalTab: (callback: () => void) => () => void
  onFocusBrowserAddressBar: (callback: () => void) => () => void
  onFindInBrowserPage: (source: BrowserFindSource, callback: () => void) => () => void
  onReloadBrowserPage: (callback: () => void) => () => void
  onBrowserHistoryNavigate: (callback: (direction: 'back' | 'forward') => void) => () => void
  onZoomBrowserPage: (callback: (direction: 'in' | 'out' | 'reset') => void) => () => void
  onHardReloadBrowserPage: (callback: () => void) => () => void
  onCloseActiveTab: (callback: () => void) => () => void
  onCloseFloatingItem: (callback: (payload: { sourceId: string }) => void) => () => void
  onSelectFloatingIndex: (callback: (payload: { index: number }) => void) => () => void
  onSwitchTab: (callback: (direction: 1 | -1) => void) => () => void
  onSwitchTabAcrossAllTypes: (callback: (direction: 1 | -1) => void) => () => void
  onSwitchRecentTab: (callback: () => void) => () => void
  onSwitchTerminalTab: (callback: (direction: 1 | -1) => void) => () => void
  onCtrlTabKeyDown: (callback: (data: { shiftKey: boolean }) => void) => () => void
  onCtrlTabKeyUp: (callback: () => void) => () => void
  onToggleStatusBar: (callback: () => void) => () => void
  onDictationKeyDown: (callback: () => void) => () => void
  onExportPdfRequested: (callback: () => void) => () => void
  onAppMenuPaste: (callback: () => void) => () => void
  onAppMenuSelectionAction: (callback: (action: 'copy' | 'select-all') => void) => () => void
  onEditableContextPaste: (callback: (data: { plainTextOnly: boolean }) => void) => () => void
  onActivateWorktree: (
    callback: (data: {
      repoId: string
      worktreeId: string
      setup?: WorktreeSetupLaunch
      startup?: WorktreeStartupLaunch
      defaultTabs?: WorktreeDefaultTabsLaunch
    }) => void
  ) => () => void
  onCreateTerminal: (
    callback: (data: {
      requestId?: string
      worktreeId: string
      command?: string
      cwd?: string
      env?: Record<string, string>
      launchConfig?: SleepingAgentLaunchConfig
      resumeProviderSession?: AgentProviderSessionMetadata
      launchToken?: string
      launchAgent?: TuiAgent
      viewMode?: 'terminal' | 'chat'
      title?: string
      ptyId?: string
      activate?: boolean
      focus?: boolean
      presentation?: RuntimeTerminalPresentation
      surfaceOwner?: false
      tabId?: string
      leafId?: string
      splitFromLeafId?: string
      splitDirection?: 'horizontal' | 'vertical'
      splitTelemetrySource?: TerminalPaneSplitSource
    }) => void
  ) => () => void
  onRequestTerminalCreate: (
    callback: (data: RuntimeTerminalCreateRequestPayload) => void
  ) => () => void
  onRequestTerminalTabMount: (
    callback: (data: { worktreeId: string; tabId?: string; ptyId?: string }) => void
  ) => () => void
  replyTerminalCreate: (reply: TerminalTabCreateReply) => void
  onSplitTerminal: (
    callback: (data: {
      tabId: string
      paneRuntimeId: number
      direction: 'horizontal' | 'vertical'
      command?: string
      telemetrySource?: TerminalPaneSplitSource
    }) => void
  ) => () => void
  onRenameTerminal: (
    callback: (data: { tabId: string; title: string | null }) => void
  ) => () => void
  onFocusTerminal: (
    callback: (data: {
      tabId: string
      worktreeId: string
      leafId?: string | null
      ackPaneKeyOnSuccess?: string
      flashFocusedPane?: boolean
      scrollToBottomIfOutputSinceLastView?: boolean
    }) => void
  ) => () => void
  onFocusEditorTab: (callback: (data: { tabId: string; worktreeId: string }) => void) => () => void
  onCloseSessionTab: (callback: (data: { tabId: string; worktreeId: string }) => void) => () => void
  onSessionTabCloseRequest: (callback: (request: SessionTabCloseRequest) => void) => () => void
  respondSessionTabClose: (response: SessionTabCloseResponse) => void
  onMoveSessionTab: (
    callback: (data: { worktreeId: string } & RuntimeMobileSessionTabMove) => void
  ) => () => void
  onOpenFileFromMobile: (
    callback: (data: {
      worktreeId: string
      filePath: string
      relativePath: string
      runtimeEnvironmentId?: string
    }) => void
  ) => () => void
  onOpenDiffFromMobile: (
    callback: (data: {
      worktreeId: string
      filePath: string
      relativePath: string
      staged: boolean
      runtimeEnvironmentId?: string
    }) => void
  ) => () => void
  onMobileMarkdownRequest: (callback: (request: RuntimeMobileMarkdownRequest) => void) => () => void
  respondMobileMarkdownRequest: (response: RuntimeMobileMarkdownResponse) => void
  onCloseTerminal: (
    callback: (data: { tabId: string; paneRuntimeId?: number }) => void
  ) => () => void
  onTerminalTabCloseRequest: (callback: (request: TerminalTabCloseRequest) => void) => () => void
  respondTerminalTabClose: (response: TerminalTabCloseResponse) => void
  onSleepWorktree: (callback: (data: { worktreeId: string }) => void) => () => void
  onResumeSleepingAgents: (callback: (data: { worktreeId: string }) => void) => () => void
  onTerminalZoom: (callback: (direction: 'in' | 'out' | 'reset') => void) => () => void
  onSystemResumed: (callback: () => void) => () => void
}
