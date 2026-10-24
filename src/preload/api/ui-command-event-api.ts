import type {
  RuntimeEditorTabReveal,
  RuntimeFileOpenPosition
} from '../../shared/runtime-file-contracts'
import type { JiraQuickFilterState } from '../../shared/jira-quick-filters'
import type {
  JiraSavedFilterState,
  JiraSavedFilterMutation
} from '../../shared/jira/jira-saved-filters'
import type { MarkdownDocument } from '../../shared/filesystem-entry-types'
import type { PersistedUIState } from '../../shared/persisted-ui-state-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type {
  AgentLaunchTabPublishReply,
  AgentLaunchTabViewerRule,
  AgentLaunchTabPublishRequest
} from '../../shared/agent-launch-tab-publication'
import type { AgentLaunchPaneVerdictEvent } from '../../shared/agent-launch-pane-verdict'
import type {
  TerminalPaneRevealReply,
  TerminalPaneRevealRequest
} from '../../shared/terminal-pane-reveal'
import type { RuntimeNavigationTarget } from '../../shared/runtime-navigation'
import type {
  ProjectMovePauseRequest,
  ProjectMovePauseResponse
} from '../../shared/project-move-pause'
import type { TerminalSurfaceCloseTarget } from '../../shared/terminal-surface-close-target'
import type {
  WorktreeDefaultTabsLaunch,
  WorktreeSetupLaunch,
  WorktreeStartupLaunch
} from '../../shared/worktree/launch-types'
import type { FeatureInteractionId } from '../../shared/feature-interactions'
import type { KeybindingActionId } from '../../shared/keybindings'
import type { BrowserFindSource } from '../../shared/browser-find-source'
import type {
  BrowserHistoryNavigateCommand,
  BrowserPageCommandTarget
} from '../../shared/browser-page-command-target'
import type { BrowserPageZoomCommand } from '../../shared/browser-page-zoom'
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
import type { TerminalTabCreateReply } from '../../shared/terminal-reveal-identity'
import type {
  TerminalTabCloseRequest,
  TerminalTabCloseResponse
} from '../../shared/terminal-tab-close'
import type {
  SessionTabCloseRequest,
  SessionTabCloseResponse
} from '../../shared/session-tab-close'
import type { WorkspaceSleepNotice } from '../../shared/workspace-sleep'
import type {
  RemoteCliBrowserScopeQuery,
  RemoteCliBrowserScopeReply
} from '../../shared/desktop-browser-bridge-protocol'

export type CloseActiveTabPayload = { sourceId: string }

export type UiCommandEventApi = {
  getJiraQuickFilters?: () => Promise<JiraQuickFilterState>
  setJiraQuickFilters?: (state: JiraQuickFilterState) => Promise<JiraQuickFilterState>
  getJiraSavedFilters?: () => Promise<JiraSavedFilterState>
  mutateJiraSavedFilters?: (mutation: JiraSavedFilterMutation) => Promise<JiraSavedFilterState>
  get: () => Promise<PersistedUIState>
  set: (args: Partial<PersistedUIState>) => Promise<void>
  /** Unlike web set, rejects transport failures so the diff writer retries unacknowledged patches. */
  setWithAck?: (args: Partial<PersistedUIState>) => Promise<void>
  recordFeatureInteraction: (id: FeatureInteractionId) => Promise<PersistedUIState>
  onStateChanged: (callback: (ui: PersistedUIState) => void) => () => void
  onOpenSettings: (callback: () => void) => () => void
  consumePendingOpenSettings: () => Promise<boolean>
  onOpenSkillShare: (callback: (shareId: string) => void) => () => void
  consumePendingSkillShare: () => Promise<string | null>
  /** OS "Open With" Markdown/CSV/TSV documents; the local IPC name is retained. */
  onOpenMarkdownFiles: (callback: (documents: MarkdownDocument[]) => void) => () => void
  consumePendingMarkdownFileOpens: () => Promise<MarkdownDocument[]>
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
  /** Main asks whether a paired environment owns a workspace before running that host's CLI command. */
  onRequestRemoteCliBrowserScope: (
    callback: (data: RemoteCliBrowserScopeQuery) => void
  ) => () => void
  replyRemoteCliBrowserScope: (reply: RemoteCliBrowserScopeReply) => void
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
  onFocusBrowserAddressBar: (callback: (target: BrowserPageCommandTarget) => void) => () => void
  onShowBrowserHistory: (callback: (target: BrowserPageCommandTarget) => void) => () => void
  onFindInBrowserPage: (source: BrowserFindSource, callback: () => void) => () => void
  onReloadBrowserPage: (callback: (target: BrowserPageCommandTarget) => void) => () => void
  onBrowserHistoryNavigate: (
    callback: (command: BrowserHistoryNavigateCommand) => void
  ) => () => void
  onZoomBrowserPage: (callback: (command: BrowserPageZoomCommand) => void) => () => void
  onScrollBrowserPage?: (
    callback: (event: { browserPageId: string; deltaX: number; deltaY: number }) => void
  ) => () => void
  onHardReloadBrowserPage: (callback: (target: BrowserPageCommandTarget) => void) => () => void
  onCloseActiveTab: (callback: (payload?: CloseActiveTabPayload) => void) => () => void
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
      providesInitialSurface?: boolean
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
      targetGroupId?: string
      afterTabId?: string
      shellOverride?: string
      title?: string
      ptyId?: string
      activate?: boolean
      focus?: boolean
      presentation?: RuntimeTerminalPresentation
      surfaceOwner?: false
      agentLaunchViewer?: AgentLaunchTabViewerRule
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
  onPublishAgentLaunchTab: (callback: (data: AgentLaunchTabPublishRequest) => void) => () => void
  replyAgentLaunchTabPublish: (reply: AgentLaunchTabPublishReply) => void
  onAgentLaunchPaneVerdict: (callback: (data: AgentLaunchPaneVerdictEvent) => void) => () => void
  onRevealTerminalPane: (callback: (data: TerminalPaneRevealRequest) => void) => () => void
  replyTerminalPaneReveal: (reply: TerminalPaneRevealReply) => void
  onSplitTerminal: (
    callback: (data: {
      tabId: string
      paneRuntimeId: number
      direction: 'horizontal' | 'vertical'
      command?: string
      worktreeId?: string
      sourceLeafId?: string
      telemetrySource?: TerminalPaneSplitSource
      newLeafId?: string
    }) => void
  ) => () => void
  onRenameTerminal: (
    callback: (data: { tabId: string; title: string | null; recordInteraction?: false }) => void
  ) => () => void
  onSetPaneTitle?: (
    callback: (data: { tabId: string; leafId: string; title: string | null }) => void
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
  onFocusEditorTab: (
    callback: (data: {
      tabId: string
      worktreeId: string
      /** A notification click authorizes revealing the tab. */
      userInitiated?: boolean
    }) => void
  ) => () => void
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
      runtimeEnvironmentId?: string | null
      navigation?: RuntimeNavigationTarget
      position?: RuntimeFileOpenPosition
    }) => void
  ) => () => void
  onRevealEditorTabFromRuntime: (callback: (data: RuntimeEditorTabReveal) => void) => () => void
  onOpenDiffFromMobile: (
    callback: (data: {
      worktreeId: string
      filePath: string
      relativePath: string
      staged: boolean
      runtimeEnvironmentId?: string | null
      navigation?: RuntimeNavigationTarget
    }) => void
  ) => () => void
  onCloseTerminal: (callback: (target: TerminalSurfaceCloseTarget) => void) => () => void
  onTerminalTabCloseRequest: (callback: (request: TerminalTabCloseRequest) => void) => () => void
  respondTerminalTabClose: (response: TerminalTabCloseResponse) => void
  /** Follow main's workspace sleep even when another client requested it. */
  onWorkspaceSleep: (callback: (notice: WorkspaceSleepNotice) => void) => () => void
  onProjectMovePause?: (callback: (request: ProjectMovePauseRequest) => void) => () => void
  respondProjectMovePause?: (response: ProjectMovePauseResponse) => void
  onResumeSleepingAgents: (callback: (data: { worktreeId: string }) => void) => () => void
  onTerminalZoom: (callback: (direction: 'in' | 'out' | 'reset') => void) => () => void
  onSystemResumed: (callback: () => void) => () => void
}
