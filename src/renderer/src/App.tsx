/* eslint-disable max-lines */
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type SetStateAction
} from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'

import {
  ArrowLeft,
  ArrowRight,
  Minimize2,
  MoreHorizontal,
  PanelLeft,
  PanelRight
} from 'lucide-react'
import logo from '../../../resources/logo.svg'
import { SYNC_FIT_PANES_EVENT, TOGGLE_TERMINAL_PANE_EXPAND_EVENT } from '@/constants/terminal'
import { syncZoomCSSVar } from '@/lib/ui-zoom'
import { resolveLeftSidebarStyleVariables } from '@/lib/left-sidebar-appearance'
import { canShowRightSidebarForView } from '@/lib/right-sidebar-visibility'
import {
  isPairedWebClientWindow,
  shouldRenderDesktopWindowChrome
} from '@/lib/desktop-window-chrome'
import { resolveLeftTitlebarChromeLayout } from '@/lib/titlebar-left-chrome'
import { shouldShowWorktreeCreationSurface } from '@/lib/worktree-creation-surface'
import { buildAppFontFamily } from '@/lib/app-font-family'
import { toast } from 'sonner'
import { Toaster } from '@/components/ui/sonner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { useAppStore } from './store'
import { WORKTREE_REFRESH_CONCURRENCY } from './store/slices/worktrees'
import { useShallow } from 'zustand/react/shallow'
import { isRemoteWorkspaceSnapshotApplyInProgress, useIpcEvents } from './hooks/useIpcEvents'
import { useAutomationDispatchEvents } from './hooks/useAutomationDispatchEvents'
import RetainedAgentsSyncGate from './components/dashboard/RetainedAgentsSyncGate'
import { AgentHibernationGate } from './components/AgentHibernationGate'
import { ActivityTitlebarControls } from './components/activity/ActivityTitlebarControls'
import Sidebar from './components/Sidebar'
import { shutdownBufferCaptures } from './components/terminal-pane/shutdown-buffer-captures'
import { dispatchWindowCloseRequest } from './components/window-close-request-coordinator'
import {
  getSystemPrefersDarkSnapshot,
  useSystemPrefersDark
} from './components/terminal-pane/use-system-prefers-dark'
import RightSidebar from './components/right-sidebar'
import { StarNagCard } from './components/StarNagCard'
import { StarNagAgentValueMomentObserver } from './components/star-nag/StarNagAgentValueMomentObserver'
import { StarNagToastHost } from './components/star-nag/StarNagToastHost'
import { SkillFreshnessNudge } from './components/skills/SkillFreshnessNudge'
import { SkillFreshnessUpdateDialog } from './components/skills/SkillFreshnessUpdateDialog'
import { TelemetryFirstLaunchSurface } from './components/TelemetryFirstLaunchSurface'
import { ZoomOverlay } from './components/ZoomOverlay'
import { onOnboardingReopened } from './components/onboarding/show-onboarding-event'
import { shouldShowOnboarding } from './components/onboarding/should-show-onboarding'
import { MarkdownTemplatePicker } from './components/editor/MarkdownTemplatePicker'
import { FloatingTerminalToggleButton } from './components/floating-terminal/FloatingTerminalToggleButton'
import { OrcaProfileSwitcher } from './components/orca-profiles/OrcaProfileSwitcher'
import {
  TOGGLE_FLOATING_TERMINAL_EVENT,
  requestFloatingTerminalOpenMaximized
} from '@/lib/floating-terminal'
import {
  isFloatingWorkspacePanelFocused,
  isFloatingWorkspacePanelShortcut,
  isFloatingWorkspaceTerminalInputTarget,
  shouldMinimizeFloatingWorkspacePanelOnCloseShortcut
} from '@/lib/floating-workspace-terminal-actions'
import { createFloatingWorkspaceTourInteractionSnapshot } from '@/lib/floating-workspace-tour-interaction-snapshot'
import { requestScrollToCurrentWorkspaceRevealAndRename } from '@/lib/scroll-to-current-workspace-status'
import { OPEN_WORKSPACE_BOARD_EVENT } from './components/sidebar/useWorkspaceBoardPanel'
import { WorkspacePortScanner } from './components/ports/WorkspacePortScanner'
import { CrashReportDialog } from './components/crash-report/CrashReportDialog'
import NewWorkspaceComposerModal from './components/NewWorkspaceComposerModal'
import { RecoverableRenderErrorBoundary } from './components/error-boundaries/RecoverableRenderErrorBoundary'
import { ConfirmationDialogProvider } from './components/confirmation-dialog'
import { LinkRoutingPreferenceDialogProvider } from './components/link-routing-preference-dialog'
import RecentTabSwitcher from './components/tab-bar/RecentTabSwitcher'
import { useGitStatusPolling } from './components/right-sidebar/useGitStatusPolling'
import { useEditorExternalWatch } from './hooks/useEditorExternalWatch'
import { useAutoAckViewedAgent } from './hooks/useAutoAckViewedAgent'
import { useDashboardPopoutBridge } from './components/dashboard/useDashboardPopoutBridge'
import { useUnreadDockBadge } from './hooks/useUnreadDockBadge'
import {
  resolvePrimarySelectionMiddleClickPaste,
  usePrimarySelectionPaste
} from './hooks/usePrimarySelectionPaste'
import { useAppMenuPaste } from './hooks/useAppMenuPaste'
import { useLargeTextControlPaste } from './hooks/useLargeTextControlPaste'
import {
  canSkipRuntimeMobileSessionSyncKeyBuild,
  getRuntimeMobileSessionSyncKey,
  runtimeMobileSessionSyncKeysEqual,
  scheduleRuntimeGraphSync,
  setRuntimeGraphStoreStateGetter,
  setRuntimeGraphSyncEnabled
} from './runtime/sync-runtime-graph'
import { useWebSessionTabsSync } from './runtime/web-session-tabs-sync'
import { useGlobalFileDrop } from './hooks/useGlobalFileDrop'
import { useRadixBodyPointerEventsRecovery } from './hooks/useRadixBodyPointerEventsRecovery'
import { registerUpdaterBeforeUnloadBypass } from './lib/updater-beforeunload'
import {
  ORCA_APP_RESTART_ABORTED_EVENT,
  ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT
} from '../../shared/updater-renderer-events'
import { ORCA_RENDERER_UNLOAD_PREVENTED_EVENT } from '../../shared/renderer-shutdown-events'
import {
  buildWorkspaceSessionPayload,
  shouldPersistWorkspaceSession
} from './lib/workspace-session'
import { createSessionWriteSubscriber } from './lib/session-write-subscriber'
import { buildActiveViewUnloadPatch } from './lib/active-view-persist'
import {
  buildWorkspaceSessionHostSnapshots,
  fetchWorkspaceSessionWithRuntimeHostOwners,
  patchWorkspaceSessionByHost
} from './lib/workspace-session-host-persistence'
import {
  createShutdownCheckpointBeforeUnloadHandler,
  createShutdownCheckpointGuard
} from './lib/shutdown-checkpoint-guard'
import {
  collectFolderWorkspaceKeysFromSession,
  collectWorktreeHydrationRepoIdsFromSession
} from './lib/workspace-session-hydration-keys'
import {
  getStartupErrorFallbackUI,
  hydratePersistedUIAfterStartupRead
} from './lib/startup-ui-hydration'
import {
  logRendererStartupDiagnostic,
  timeRendererStartupStep,
  timeRendererStartupSyncStep
} from './startup/startup-diagnostics'
import { reconnectSshTargetForRendererStartup } from './startup/ssh-startup-reconnect'
import { shouldRenderPetOverlay } from './components/pet/pet-overlay-visibility'
import { applyDocumentTheme } from './lib/document-theme'
import { getSystemPrefersDark } from './lib/terminal-theme'
import { publishTerminalViewAttributesAtAppStart } from './components/terminal-pane/terminal-appearance'
import { isEditableTarget } from './lib/editable-target'
import { getSelectedTextForFileSearch } from './lib/file-search-selection'
import { useShortcutLabel } from './hooks/useShortcutLabel'
import {
  folderRelativePathToIncludeGlob,
  selectedExplorerFolderRelativePath
} from './components/right-sidebar/file-search-include-pattern'
import { shouldShowWorktreeHistoryControls } from './lib/titlebar-worktree-history-controls'
import {
  canGoBackWorktreeHistory,
  canGoForwardWorktreeHistory
} from '@/store/slices/worktree-nav-history'
import { selectFloatingVisibleTabCount } from './store/selectors'
import { selectActiveTerminalChromeState } from './store/active-terminal-chrome-selector'
import type { VirtualizedScrollAnchor } from './hooks/useVirtualizedScrollAnchor'
import type { RemoteWorkspacePatchResult } from '../../shared/remote-workspace-types'
import type { OnboardingState, UpdateStatus } from '../../shared/types'
import {
  getFeatureTipsAppOpenDecision,
  isCliFeatureTipCompleted
} from './components/feature-tips/feature-tip-startup-gate'
import {
  trackCmdJPaletteFeatureTipShown,
  trackOrcaCliFeatureTipShown
} from './components/feature-tips/feature-tip-telemetry'
import {
  keybindingMatchesAction,
  type KeybindingActionId,
  type KeybindingContext,
  type PhysicalModifierToken
} from '../../shared/keybindings'
import {
  getRepoExecutionHostId,
  isRuntimeOwnedSshTargetId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import {
  ModifierDoubleTapDetector,
  toModifierDoubleTapEvent
} from '../../shared/modifier-double-tap-detector'
import { isGitRepoKind } from '../../shared/repo-kind'
import { showTerminalShortcutCaptureNotification } from '@/lib/terminal-shortcut-capture-notification'
import { resolveMountedLazyModalIds, type LazyModalId } from './lazy-modal-mount-state'
import { translate } from '@/i18n/i18n'
import PinnedTabCloseDialog from './components/terminal-pane/PinnedTabCloseDialog'
import {
  hasRequestedBackgroundTerminalWorktreeMount,
  subscribeBackgroundTerminalWorktreeMountRequests
} from './components/terminal/background-terminal-worktree-mount'

// Why: bound the resume-record loss window on a hard kill to ~1 min; capture skips unchanged records so per-tick cost is negligible.
const SLEEPING_AGENT_RESUME_CAPTURE_INTERVAL_MS = 60_000

const isMac = navigator.userAgent.includes('Mac')
const isWindows = !isMac && navigator.userAgent.includes('Windows')
const shortcutPlatform: NodeJS.Platform = isMac ? 'darwin' : isWindows ? 'win32' : 'linux'
// Why: Windows and Linux remove the native title bar so the renderer draws its own chrome; paired web clients run in a browser tab and must not.
const hasCustomTitleBar = shouldRenderDesktopWindowChrome({
  platform: shortcutPlatform,
  isWebClient: isPairedWebClientWindow()
})

async function listRuntimeSessionHostIdsForStartup(): Promise<ExecutionHostId[]> {
  try {
    return (await window.api.runtimeEnvironments.list()).map((environment) =>
      toRuntimeExecutionHostId(environment.id)
    )
  } catch (err) {
    console.warn('Failed to list runtime session hosts for startup:', err)
    return []
  }
}

function getKeybindingContext(target: EventTarget | null): KeybindingContext {
  return target instanceof HTMLElement && target.classList.contains('xterm-helper-textarea')
    ? 'terminal'
    : 'app'
}

// Abstraction over a real KeyboardEvent and a synthetic double-tap gesture so one dispatch path serves both; KeybindingInput-compatible.
type ShortcutDispatchInput = {
  key?: string
  code?: string
  altKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  doubleTapModifier?: PhysicalModifierToken
  target: EventTarget | null
  defaultPrevented: boolean
  preventDefault: () => void
}

// Why: Windows and Linux both remove the native title bar, so we render our own min/max/close buttons (Fluent/Win11-style SVGs).
function WindowControls(): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    // Why: maximize-changed only fires on transitions; seed from main on mount so a startup-maximized window shows the right icon.
    let cancelled = false
    void window.api.ui.isMaximized().then((value) => {
      if (!cancelled) {
        setMaximized(value)
      }
    })
    const unsubscribe = window.api.ui.onMaximizeChanged(setMaximized)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])
  return (
    <div className="window-controls">
      <button
        className="window-controls-btn"
        aria-label={translate('auto.App.bbb7f90669', 'Minimize')}
        onClick={() => window.api.ui.minimize()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0 5h10v1H0z" fill="currentColor" />
        </svg>
      </button>
      <button
        className="window-controls-btn"
        aria-label={
          maximized
            ? translate('auto.App.66f0a552e5', 'Restore')
            : translate('auto.App.c9d6f98459', 'Maximize')
        }
        onClick={() => window.api.ui.maximize()}
      >
        {maximized ? (
          // Restore icon (two overlapping squares)
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M2 0v2H0v8h8V8h2V0H2zm6 9H1V3h7v6zM9 7H8V2H3V1h6v6z" fill="currentColor" />
          </svg>
        ) : (
          // Maximize icon (single square outline)
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M0 0v10h10V0H0zm9 9H1V1h8v8z" fill="currentColor" />
          </svg>
        )}
      </button>
      <button
        className="window-controls-btn window-controls-close"
        aria-label={translate('auto.App.e960d18540', 'Close')}
        // Why: route close through main so the 'close' event fires the terminal-running confirmation guard; window.close() is unreliable in sandboxed renderers.
        onClick={() => window.api.ui.requestClose()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M1 0L0 1l4 4-4 4 1 1 4-4 4 4 1-1-4-4 4-4-1-1-4 4-4-4z" fill="currentColor" />
        </svg>
      </button>
    </div>
  )
}

const Landing = lazy(() => import('./components/Landing'))
const WorktreeCreationPanel = lazy(
  () => import('./components/worktree-creation/WorktreeCreationPanel')
)
const TaskPage = lazy(() => import('./components/TaskPage'))
const AutomationsPage = lazy(() => import('./components/automations/AutomationsPage'))
const ActivityPrototypePage = lazy(() => import('./components/activity/ActivityPrototypePage'))
const Settings = lazy(() => import('./components/settings/Settings'))
const SkillsPage = lazy(() => import('./components/skills/SkillsPage'))
const WorkspaceSpacePage = lazy(() => import('./components/workspace-space/WorkspaceSpacePage'))
const MobilePage = lazy(() => import('./components/mobile/MobilePage'))
const QuickOpen = lazy(() => import('./components/QuickOpen'))
const WorktreeJumpPalette = lazy(() => import('./components/WorktreeJumpPalette'))
const WorkspaceCleanupDialog = lazy(
  () => import('./components/workspace-cleanup/WorkspaceCleanupDialog')
)
const Terminal = lazy(() => import('./components/Terminal'))
const StatusBar = lazy(() =>
  import('./components/status-bar/StatusBar').then((module) => ({ default: module.StatusBar }))
)
const SetupGuideModal = lazy(() => import('./components/setup-guide/SetupGuideModal'))
const FeatureWallModal = lazy(() => import('./components/feature-wall/FeatureWallModal'))
const FeatureTipsModal = lazy(() => import('./components/feature-tips/FeatureTipsModal'))
const AddRepoDialog = lazy(() => import('./components/sidebar/AddRepoDialog'))
const NonGitFolderDialog = lazy(() => import('./components/sidebar/NonGitFolderDialog'))
const AddProjectFromFolderDialog = lazy(
  () => import('./components/sidebar/AddProjectFromFolderDialog')
)
const ProjectAddedDialog = lazy(() => import('./components/sidebar/ProjectAddedDialog'))
const DeleteWorktreeDialog = lazy(() => import('./components/sidebar/DeleteWorktreeDialog'))
const DictationController = lazy(() =>
  import('./components/dictation/DictationController').then((module) => ({
    default: module.DictationController
  }))
)
const SshPassphraseDialog = lazy(() =>
  import('./components/settings/SshPassphraseDialog').then((module) => ({
    default: module.SshPassphraseDialog
  }))
)
const UpdateCard = lazy(() =>
  import('./components/UpdateCard').then((module) => ({ default: module.UpdateCard }))
)
const RemoteServerUpdateDialog = lazy(
  () => import('./components/settings/RemoteServerUpdateDialog')
)
const ContextualTourOverlay = lazy(() =>
  import('./components/contextual-tours/ContextualTourOverlay').then((module) => ({
    default: module.ContextualTourOverlay
  }))
)
const SetupGuideTelemetryObserver = lazy(() =>
  import('./components/setup-guide/SetupGuideTelemetryObserver').then((module) => ({
    default: module.SetupGuideTelemetryObserver
  }))
)
const FloatingTerminalPanel = lazy(() =>
  import('./components/floating-terminal/FloatingTerminalPanel').then((module) => ({
    default: module.FloatingTerminalPanel
  }))
)
// Why: lazy so the WebP asset + overlay module aren't fetched unless the experimental flag is on.
const PetOverlay = lazy(() => import('./components/pet/PetOverlay'))
// Why: lazy so onboarding's step modules + assets aren't fetched for users past first-launch.
const OnboardingFlow = lazy(() => import('./components/onboarding/OnboardingFlow'))

function applyRemoteWorkspacePatchStatus(
  targetId: string,
  result: RemoteWorkspacePatchResult
): void {
  const store = useAppStore.getState()
  if (result.ok) {
    store.setRemoteWorkspaceSyncStatus(targetId, {
      phase: 'synced',
      direction: 'push',
      revision: result.snapshot.revision,
      updatedAt: result.snapshot.updatedAt,
      lastSyncedAt: Date.now(),
      message: translate('auto.App.332dbfa497', 'Workspace uploaded')
    })
    return
  }
  store.setRemoteWorkspaceSyncStatus(targetId, {
    phase: result.reason === 'stale-revision' ? 'conflict' : 'offline',
    direction: 'push',
    revision: result.snapshot?.revision,
    updatedAt: result.snapshot?.updatedAt,
    lastSyncedAt: Date.now(),
    message:
      result.message ??
      (result.reason === 'stale-revision'
        ? 'Workspace changed on another device'
        : 'Remote workspace sync unavailable')
  })
}

function shouldMountUpdateCardForStatus(status: UpdateStatus): boolean {
  if (status.state === 'idle') {
    return false
  }
  if (status.state === 'checking' || status.state === 'not-available') {
    return status.userInitiated === true
  }
  return true
}

function App(): React.JSX.Element {
  const clearUnreadDockBadge = useUnreadDockBadge()
  useRadixBodyPointerEventsRecovery()
  useWebSessionTabsSync()
  const [floatingTerminalOpen, setFloatingTerminalOpen] = useState(false)
  const floatingWorkspaceTourInteractionSnapshotRef = useRef<{
    wasPreviouslyInteracted?: boolean
    persisted?: Promise<void>
    recordFeatureInteractionForTour: boolean
  } | null>(null)

  // Why: consolidate action refs into one useShallow subscription so React runs one equality check per store mutation instead of one per action.
  const actions = useAppStore(
    useShallow((s) => ({
      toggleSidebar: s.toggleSidebar,
      fetchRepos: s.fetchRepos,
      fetchReposForAllHosts: s.fetchReposForAllHosts,
      fetchProjectGroups: s.fetchProjectGroups,
      fetchProjectGroupsForAllHosts: s.fetchProjectGroupsForAllHosts,
      fetchFolderWorkspaces: s.fetchFolderWorkspaces,
      fetchFolderWorkspacesForAllHosts: s.fetchFolderWorkspacesForAllHosts,
      fetchAllWorktrees: s.fetchAllWorktrees,
      fetchWorktrees: s.fetchWorktrees,
      fetchWorktreeLineage: s.fetchWorktreeLineage,
      fetchOrcaProfiles: s.fetchOrcaProfiles,
      fetchSettings: s.fetchSettings,
      fetchKeybindings: s.fetchKeybindings,
      initGitHubCache: s.initGitHubCache,
      refreshAllGitHub: s.refreshAllGitHub,
      reportVisibleGitHubPRRefreshCandidates: s.reportVisibleGitHubPRRefreshCandidates,
      bumpGitHubPRVisibleRefreshGeneration: s.bumpGitHubPRVisibleRefreshGeneration,
      hydrateWorkspaceSession: s.hydrateWorkspaceSession,
      hydrateTabsSession: s.hydrateTabsSession,
      hydrateEditorSession: s.hydrateEditorSession,
      hydrateBrowserSession: s.hydrateBrowserSession,
      fetchBrowserSessionProfiles: s.fetchBrowserSessionProfiles,
      reconnectPersistedTerminals: s.reconnectPersistedTerminals,
      setDeferredSshReconnectTargets: s.setDeferredSshReconnectTargets,
      setSshConnectionState: s.setSshConnectionState,
      hydratePersistedUI: s.hydratePersistedUI,
      setHydrationSucceeded: s.setHydrationSucceeded,
      openModal: s.openModal,
      closeModal: s.closeModal,
      markFeatureTipsSeen: s.markFeatureTipsSeen,
      setContextualToursAutoEligible: s.setContextualToursAutoEligible,
      setContextualToursOnboardingVisible: s.setContextualToursOnboardingVisible,
      cancelContextualTour: s.cancelContextualTour,
      toggleRightSidebar: s.toggleRightSidebar,
      setRightSidebarOpen: s.setRightSidebarOpen,
      setRightSidebarTab: s.setRightSidebarTab,
      showRightSidebarFiles: s.showRightSidebarFiles,
      showRightSidebarSearch: s.showRightSidebarSearch,
      openDiffNotesSendMenuForActiveWorktree: s.openDiffNotesSendMenuForActiveWorktree,
      setActiveView: s.setActiveView,
      updateSettings: s.updateSettings,
      pruneLastVisitedTimestamps: s.pruneLastVisitedTimestamps,
      seedActiveWorktreeLastVisitedIfMissing: s.seedActiveWorktreeLastVisitedIfMissing
    }))
  )

  const activeView = useAppStore((s) => s.activeView)
  const activeModal = useAppStore((s) => s.activeModal)
  const featureTipsSeenIds = useAppStore((s) => s.featureTipsSeenIds)
  const featureInteractions = useAppStore((s) => s.featureInteractions)
  const contextualToursAutoEligible = useAppStore((s) => s.contextualToursAutoEligible)
  const {
    activeWorktreeId,
    tabCount,
    effectiveActiveTabId,
    activeTabCanExpand,
    effectiveActiveTabExpanded
  } = useAppStore(useShallow(selectActiveTerminalChromeState))
  const activePendingCreationId = useAppStore((s) => s.activePendingCreationId)
  // Why: the creation surface owns the tab strip from the first pending frame; gating on the delayed loader flag swapped the tab bar mid-create.
  const activePendingCreationExists = useAppStore(
    (s) =>
      s.activePendingCreationId !== null &&
      s.pendingWorktreeCreations[s.activePendingCreationId] !== undefined
  )
  // Why: keep virtualized scroll memory above the sidebar's workspace/landing remount so the left list doesn't restart at scrollTop 0.
  const worktreeSidebarScrollOffsetRef = useRef(0)
  const worktreeSidebarScrollAnchorRef = useRef<VirtualizedScrollAnchor>(null)
  const floatingVisibleTabCount = useAppStore(selectFloatingVisibleTabCount)
  const workspaceSessionReady = useAppStore((s) => s.workspaceSessionReady)
  const backgroundTerminalMountRequested = useSyncExternalStore(
    subscribeBackgroundTerminalWorktreeMountRequests,
    hasRequestedBackgroundTerminalWorktreeMount,
    hasRequestedBackgroundTerminalWorktreeMount
  )
  const keybindings = useAppStore((s) => s.keybindings)
  const updateStatus = useAppStore((s) => s.updateStatus)
  const activeContextualTourId = useAppStore((s) => s.activeContextualTourId)
  const leftSidebarShortcutLabel = useShortcutLabel('sidebar.left.toggle')
  const rightSidebarShortcutLabel = useShortcutLabel('sidebar.right.toggle')
  const historyBackShortcutLabel = useShortcutLabel('worktree.history.back')
  const historyForwardShortcutLabel = useShortcutLabel('worktree.history.forward')
  const floatingTerminalEnabled = useAppStore((s) => s.settings?.floatingTerminalEnabled === true)
  const floatingTerminalTriggerLocation = useAppStore(
    (s) => s.settings?.floatingTerminalTriggerLocation ?? 'floating-button'
  )
  const statusBarVisible = useAppStore((s) => s.statusBarVisible)
  const showFloatingTerminalButton =
    floatingTerminalEnabled &&
    (floatingTerminalTriggerLocation === 'floating-button' || !statusBarVisible)
  const hasMountedTerminalWorkbenchRef = useRef(false)
  if (activeWorktreeId !== null || backgroundTerminalMountRequested) {
    hasMountedTerminalWorkbenchRef.current = true
  }
  // Why: skip the terminal bundle on the landing path, but once mounted keep hidden panes alive through sleep/shutdown when activeWorktreeId briefly goes null.
  const shouldMountTerminalWorkbench =
    activeWorktreeId !== null ||
    backgroundTerminalMountRequested ||
    hasMountedTerminalWorkbenchRef.current
  // Why: visible worktree creation owns its faux tab strip start to finish; keep the previous workspace mounted for retention without real chrome.
  const creationLayoutActive = shouldShowWorktreeCreationSurface({
    activeView,
    activePendingCreationId,
    hasActivePendingCreation: activePendingCreationExists
  })
  const workspaceChromeActive =
    activeView === 'terminal' && activeWorktreeId !== null && !creationLayoutActive
  const terminalWorkbenchVisible =
    activeView === 'terminal' && activeWorktreeId !== null && !creationLayoutActive
  // Why: once the floating workspace owns tabs, keep it mounted while closed so hidden terminal/browser/editor panes retain local state.
  const shouldMountFloatingTerminalPanel =
    floatingTerminalEnabled && (floatingTerminalOpen || floatingVisibleTabCount > 0)
  // Why: floating workspace is a transient overlay; hotkey minimize returns focus to the surface the user came from.
  const floatingTerminalReturnFocusRef = useRef<HTMLElement | null>(null)
  const floatingTerminalReturnFocusFrameRef = useRef<number | null>(null)

  const cancelFloatingTerminalReturnFocusFrame = useCallback((): void => {
    if (floatingTerminalReturnFocusFrameRef.current === null) {
      return
    }
    cancelAnimationFrame(floatingTerminalReturnFocusFrameRef.current)
    floatingTerminalReturnFocusFrameRef.current = null
  }, [])

  const setAppRootNode = useCallback(
    (node: HTMLDivElement | null): void => {
      // Why: these best-effort App chrome cleanups share the App root lifetime.
      if (!node) {
        cancelFloatingTerminalReturnFocusFrame()
        clearUnreadDockBadge()
      }
    },
    [cancelFloatingTerminalReturnFocusFrame, clearUnreadDockBadge]
  )

  const rememberFloatingTerminalReturnFocus = useCallback((): void => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement)) {
      floatingTerminalReturnFocusRef.current = null
      return
    }
    if (
      active.closest('[data-floating-terminal-panel]') ||
      active.closest('[data-floating-terminal-toggle]')
    ) {
      return
    }
    floatingTerminalReturnFocusRef.current = active
  }, [])

  const restoreFloatingTerminalReturnFocus = useCallback((): void => {
    const target = floatingTerminalReturnFocusRef.current
    floatingTerminalReturnFocusRef.current = null
    if (!target || !document.contains(target)) {
      return
    }
    cancelFloatingTerminalReturnFocusFrame()
    floatingTerminalReturnFocusFrameRef.current = requestAnimationFrame(() => {
      floatingTerminalReturnFocusFrameRef.current = null
      if (!document.contains(target)) {
        return
      }
      target.focus({ preventScroll: true })
    })
  }, [cancelFloatingTerminalReturnFocusFrame])

  const setFloatingTerminalOpenWithFocus = useCallback(
    (nextOpen: SetStateAction<boolean>): void => {
      const resolvedOpen =
        typeof nextOpen === 'function' ? nextOpen(floatingTerminalOpen) : nextOpen
      // Why: recordFeatureInteraction updates Zustand subscribers; running it inside the state updater logs a render-phase update warning.
      if (resolvedOpen && !floatingTerminalOpen) {
        const state = useAppStore.getState()
        floatingWorkspaceTourInteractionSnapshotRef.current =
          createFloatingWorkspaceTourInteractionSnapshot(state)
        rememberFloatingTerminalReturnFocus()
      } else if (!resolvedOpen && floatingTerminalOpen) {
        restoreFloatingTerminalReturnFocus()
      }
      setFloatingTerminalOpen(resolvedOpen)
    },
    [floatingTerminalOpen, rememberFloatingTerminalReturnFocus, restoreFloatingTerminalReturnFocus]
  )

  useEffect(() => {
    const toggleFloatingTerminal = (): void => {
      if (floatingTerminalEnabled) {
        setFloatingTerminalOpenWithFocus((open) => !open)
      }
    }
    window.addEventListener(TOGGLE_FLOATING_TERMINAL_EVENT, toggleFloatingTerminal)
    return () => window.removeEventListener(TOGGLE_FLOATING_TERMINAL_EVENT, toggleFloatingTerminal)
  }, [floatingTerminalEnabled, setFloatingTerminalOpenWithFocus])

  useEffect(() => {
    if (!floatingTerminalEnabled) {
      setFloatingTerminalOpenWithFocus(false)
    }
  }, [floatingTerminalEnabled, setFloatingTerminalOpenWithFocus])

  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const groupBy = useAppStore((s) => s.groupBy)
  const sortBy = useAppStore((s) => s.sortBy)
  const projectOrderBy = useAppStore((s) => s.projectOrderBy)
  const showSleepingWorkspaces = useAppStore((s) => s.showSleepingWorkspaces)
  const hideDefaultBranchWorkspace = useAppStore((s) => s.hideDefaultBranchWorkspace)
  const hideAutomationGeneratedWorkspaces = useAppStore((s) => s.hideAutomationGeneratedWorkspaces)
  const showDotfilesByWorktree = useAppStore((s) => s.showDotfilesByWorktree)
  const filterRepoIds = useAppStore((s) => s.filterRepoIds)
  const acknowledgedAgentsByPaneKey = useAppStore((s) => s.acknowledgedAgentsByPaneKey)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const shouldMountContextualTourOverlay = activeContextualTourId !== null
  const shouldMountSetupGuideTelemetryObserver = persistedUIReady
  const shouldMountUpdateCard = shouldMountUpdateCardForStatus(updateStatus)
  const rightSidebarWidth = useAppStore((s) => s.rightSidebarWidth)
  const markdownTocPanelWidth = useAppStore((s) => s.markdownTocPanelWidth)
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab)
  const rightSidebarExplorerView = useAppStore((s) => s.rightSidebarExplorerView)
  const isFullScreen = useAppStore((s) => s.isFullScreen)
  const settings = useAppStore((s) => s.settings)
  const systemPrefersDark = useSystemPrefersDark()
  const leftSidebarStyle = useMemo(
    () => resolveLeftSidebarStyleVariables(settings, systemPrefersDark),
    [settings, systemPrefersDark]
  ) as React.CSSProperties | undefined
  const dictationState = useAppStore((s) => s.dictationState)
  const hasSshCredentialRequest = useAppStore((s) => s.sshCredentialQueue.length > 0)
  const shouldMountDictationController =
    settings?.voice?.enabled === true || dictationState !== 'idle'
  const primarySelectionMiddleClickPaste = resolvePrimarySelectionMiddleClickPaste(
    settings?.primarySelectionMiddleClickPaste
  )
  usePrimarySelectionPaste(primarySelectionMiddleClickPaste)
  useAppMenuPaste()
  useLargeTextControlPaste()
  const petEnabled = useAppStore((s) => s.settings?.experimentalPet === true)
  const petVisible = useAppStore((s) => s.petVisible)
  const renderPetOverlay = shouldRenderPetOverlay({
    persistedUIReady,
    petEnabled,
    petVisible
  })
  const canGoBackWorktree = useAppStore(canGoBackWorktreeHistory)
  const canGoForwardWorktree = useAppStore(canGoForwardWorktreeHistory)
  const titlebarLeftControlsRef = useRef<HTMLDivElement | null>(null)
  const [collapsedSidebarHeaderWidth, setCollapsedSidebarHeaderWidth] = useState(0)
  const [mountedLazyModalIds, setMountedLazyModalIds] = useState<Set<LazyModalId>>(() => new Set())
  const [shouldMountAddRepoDialog, setShouldMountAddRepoDialog] = useState(false)
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null)
  const [onboardingLoaded, setOnboardingLoaded] = useState(false)
  const featureTipsPromptedThisSessionRef = useRef(false)
  const featureTipsSuppressedByOnboardingThisSessionRef = useRef(false)
  const unmountAddRepoDialogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [featureTipCliInstalled, setFeatureTipCliInstalled] = useState<boolean | null>(null)
  const [onboardingSettingsDetour, setOnboardingSettingsDetour] = useState(false)
  const shouldRenderOnboarding = onboarding !== null && shouldShowOnboarding(onboarding)
  const onboardingSettingsDetourActive =
    onboardingSettingsDetour && activeView === 'settings' && shouldRenderOnboarding
  if (onboardingSettingsDetour && !onboardingSettingsDetourActive) {
    // Why: the detour is valid only while Settings is onscreen; clear it during render so onboarding resumes without an extra Effect pass.
    setOnboardingSettingsDetour(false)
  }

  useEffect(() => {
    if (activeModal === 'add-repo') {
      if (unmountAddRepoDialogTimerRef.current) {
        clearTimeout(unmountAddRepoDialogTimerRef.current)
        unmountAddRepoDialogTimerRef.current = null
      }
      setShouldMountAddRepoDialog(true)
      return
    }
    if (shouldMountAddRepoDialog && !unmountAddRepoDialogTimerRef.current) {
      // Why: AddRepoDialog's close effect aborts in-flight clone work; keep one closed render before unmounting hidden SSH/remote subscriptions.
      unmountAddRepoDialogTimerRef.current = setTimeout(() => {
        setShouldMountAddRepoDialog(false)
        unmountAddRepoDialogTimerRef.current = null
      }, 0)
    }
    return () => {
      if (unmountAddRepoDialogTimerRef.current) {
        clearTimeout(unmountAddRepoDialogTimerRef.current)
        unmountAddRepoDialogTimerRef.current = null
      }
    }
  }, [activeModal, shouldMountAddRepoDialog])

  // Subscribe to IPC push events
  useIpcEvents()
  useAutomationDispatchEvents()
  // Why: retention runs at App level (in <RetainedAgentsSyncGate />, a null leaf) so "done" agents survive card collapse and its high-churn subscriptions don't re-render App.
  // Why: git polling lives at App level (RightSidebar unmounts when closed, stranding stale Rebasing/Merging badges); gate on workspaceSessionReady so it doesn't compete with first paint.
  useGitStatusPolling({ enabled: workspaceSessionReady })
  // Why: wire file-change watching at App level so the editor keeps hearing FS changes when Explorer unmounts (right-sidebar switches to Source Control/Checks).
  useEditorExternalWatch()
  useGlobalFileDrop()
  useAutoAckViewedAgent()
  useDashboardPopoutBridge(settings?.experimentalAgentDashboardPopout === true)

  useEffect(() => {
    return onOnboardingReopened(setOnboarding)
  }, [])

  useEffect(() => {
    // Why: suppress tours until onboarding state is known (null = loading) so a first-run user can't mark a tour seen before onboarding appears.
    const suppressTours = !onboardingLoaded || shouldShowOnboarding(onboarding)
    actions.setContextualToursOnboardingVisible(suppressTours)
  }, [actions, onboarding, onboardingLoaded])

  useEffect(() => {
    if (!persistedUIReady || !onboardingLoaded || contextualToursAutoEligible !== null) {
      return
    }
    // Why: rollout targets first-run onboarding users; existing profiles are classified once and never auto-toured.
    actions.setContextualToursAutoEligible(shouldShowOnboarding(onboarding))
  }, [actions, contextualToursAutoEligible, onboarding, onboardingLoaded, persistedUIReady])

  useEffect(() => {
    if (!persistedUIReady) {
      return
    }

    let cancelled = false
    void window.api.cli
      .getInstallStatus()
      .then((status) => {
        if (cancelled) {
          return
        }
        setFeatureTipCliInstalled(isCliFeatureTipCompleted(status))
      })
      .catch(() => {
        if (!cancelled) {
          setFeatureTipCliInstalled(true)
        }
      })

    return () => {
      cancelled = true
    }
  }, [persistedUIReady])

  useEffect(() => {
    const featureTipsDecision = getFeatureTipsAppOpenDecision({
      activeModal,
      cliInstalled: featureTipCliInstalled,
      featureTipsSeenIds,
      featureInteractions,
      onboarding,
      persistedUIReady,
      promptedThisSession: featureTipsPromptedThisSessionRef.current,
      settings,
      suppressedByOnboardingThisSession: featureTipsSuppressedByOnboardingThisSessionRef.current
    })

    if (featureTipsDecision.kind === 'suppress-for-onboarding') {
      // Why: first-run users should finish onboarding without a second education modal in the same session.
      featureTipsSuppressedByOnboardingThisSessionRef.current = true
      return
    }

    if (featureTipsDecision.kind !== 'open') {
      return
    }

    featureTipsPromptedThisSessionRef.current = true
    if (featureTipsDecision.tipId === 'orca-cli') {
      trackOrcaCliFeatureTipShown('app_open')
    } else if (featureTipsDecision.tipId === 'cmd-j-palette') {
      trackCmdJPaletteFeatureTipShown('app_open')
    }
    // Why: mark seen on show so a quit/crash before dismiss doesn't reappear it next launch.
    actions.markFeatureTipsSeen([featureTipsDecision.tipId])
    actions.openModal('feature-tips', { source: 'app_open', tipId: featureTipsDecision.tipId })
  }, [
    activeModal,
    actions,
    featureTipCliInstalled,
    featureInteractions,
    featureTipsSeenIds,
    onboarding,
    persistedUIReady,
    settings
  ])

  const beginOnboardingSettingsDetour = useCallback(() => {
    setOnboardingSettingsDetour(true)
  }, [])

  // Why: useLayoutEffect fires before paint, so dispatching SYNC_FIT_PANES_EVENT reflows the terminal in the same frame as the width change — no wrongly-sized transient.
  useLayoutEffect(() => {
    window.dispatchEvent(new CustomEvent(SYNC_FIT_PANES_EVENT))
  }, [sidebarOpen, rightSidebarOpen])

  // Fetch initial data + hydrate GitHub cache from disk
  useEffect(() => {
    let cancelled = false
    // Why: declared outside the async block so cleanup can abort it — under StrictMode the first (unmounted) pass would otherwise keep spawning PTYs.
    const abortController = new AbortController()

    // Why (issue #1158): hydrate persisted UI right after ui.get() succeeds; the UI writer is gated only on persistedUIReady, so later default fallback would serialize defaults to disk.
    let uiHydrated = false
    // Why (issue #1158): track whether success-path reconnect started so the catch doesn't re-run it — re-entering on partially-mutated state would double-set ptyIds and drain pending* twice.
    let reconnectStarted = false
    void (async () => {
      const startupStartedAt = performance.now()
      logRendererStartupDiagnostic('startup-chain-start')
      try {
        // Why: nothing in the hydration chain reads profile state synchronously, so don't let it add a serial IPC round-trip before fetchSettings.
        void actions.fetchOrcaProfiles()
        // Why: repo/worktree hydration routes through settings.activeRuntimeEnvironmentId; load settings first so a persisted remote runtime doesn't hydrate stale local state.
        await timeRendererStartupStep('fetch-settings', () => actions.fetchSettings())
        // Why: hidden-at-launch PTYs can query OSC 10/11 before any pane mounts; publish view attributes as soon as settings exist so main's silent-until-push responder has data.
        publishTerminalViewAttributesAtAppStart(
          useAppStore.getState().settings,
          getSystemPrefersDark()
        )
        // Why: start keybindings + onboarding now so their IPC overlaps the local catalog scans; await them at their original spots. The .catch marks rejections handled if an earlier await throws first.
        // Why: browser session profiles are NOT started early — on a remote runtime the RPC may be unconnected and a failed fetch clears the list.
        const keybindingsPromise = timeRendererStartupStep('fetch-keybindings', () =>
          actions.fetchKeybindings()
        )
        keybindingsPromise.catch(() => {})
        const onboardingPromise = timeRendererStartupStep('onboarding-get', () =>
          window.api.onboarding.get()
        )
        onboardingPromise.catch(() => {})
        // Why: await ui.get() (not overlap) so persisted view settings hydrate before the local catalog/session steps and first paint reflects them.
        const persistedUI = await timeRendererStartupStep('ui-get', () => window.api.ui.get())
        uiHydrated = timeRendererStartupSyncStep('hydrate-persisted-ui', () =>
          hydratePersistedUIAfterStartupRead({
            persistedUI,
            cancelled,
            hydratePersistedUI: actions.hydratePersistedUI
          })
        )
        // Why: list-runtime-session-hosts reads no repo state, so overlap it with the repo scan
        // instead of paying its IPC round-trip serially before repos. .catch marks rejections handled
        // if an earlier await throws first; the value is awaited below and surfaces any error there.
        const runtimeHostsPromise = timeRendererStartupStep(
          'list-runtime-session-hosts',
          listRuntimeSessionHostIdsForStartup
        )
        runtimeHostsPromise.catch(() => {})
        // Why: saved remote runtimes can spend the full connect timeout; load only the local catalog for first paint and refresh remotes after hydration.
        await timeRendererStartupStep('fetch-repos-local', () =>
          actions.fetchReposForAllHosts({ remoteHosts: 'skip' })
        )
        // Why: folder workspaces merge against projectGroups (repos.ts fetchFolderWorkspacesForAllHosts),
        // so keep this chain ordered while overlapping it with session-scoped hydration.
        const localCatalogChain = (async () => {
          await timeRendererStartupStep('fetch-project-groups-local', () =>
            actions.fetchProjectGroupsForAllHosts({ remoteHosts: 'skip' })
          )
          await timeRendererStartupStep('fetch-folder-workspaces-local', () =>
            actions.fetchFolderWorkspacesForAllHosts({ remoteHosts: 'skip' })
          )
        })()
        const sessionReadPromise = runtimeHostsPromise.then((startupRuntimeHostIds) =>
          // Why: include saved runtime host ids so per-host worktree session slices restore from local settings without waiting on network reachability; unreadable partitions skip.
          timeRendererStartupStep('session-get', () =>
            fetchWorkspaceSessionWithRuntimeHostOwners(
              window.api.session,
              useAppStore.getState().repos,
              startupRuntimeHostIds
            )
          )
        )
        const hydrationSessionChain = sessionReadPromise.then(async (sessionRead) => {
          const hydrationRepoIds = collectWorktreeHydrationRepoIdsFromSession(
            sessionRead.session,
            sessionRead.runtimeHostIdByWorkspaceSessionKey
          )
          const hydrationRepoIdSet = new Set(hydrationRepoIds)
          const hydrationRepos = useAppStore.getState().repos.filter(
            (repo) =>
              hydrationRepoIdSet.has(repo.id) &&
              // Why: disconnected SSH repos hydrate from local metadata; only runtime-owned repos use placeholders.
              parseExecutionHostId(getRepoExecutionHostId(repo))?.kind !== 'runtime'
          )
          await timeRendererStartupStep('fetch-hydration-worktrees', () =>
            mapWithConcurrency(hydrationRepos, WORKTREE_REFRESH_CONCURRENCY, (repo) =>
              actions.fetchWorktrees(repo.id, { executionHostId: getRepoExecutionHostId(repo) })
            )
          )
          return sessionRead
        })
        // Why: wait for both writers to settle before recovery so neither can mutate hydrated state afterward.
        const [sessionOutcome, catalogOutcome] = await Promise.allSettled([
          hydrationSessionChain,
          localCatalogChain
        ])
        if (sessionOutcome.status === 'rejected') {
          throw sessionOutcome.reason
        }
        if (catalogOutcome.status === 'rejected') {
          throw catalogOutcome.reason
        }
        const sessionRead = sessionOutcome.value
        await keybindingsPromise
        if (!cancelled) {
          const sessionHydrationOptions = {
            additionalValidWorkspaceKeys: collectFolderWorkspaceKeysFromSession(sessionRead.session)
          }
          timeRendererStartupSyncStep('hydrate-session-stores', () => {
            actions.hydrateWorkspaceSession(sessionRead.session, {
              ...sessionHydrationOptions,
              runtimeHostIdByWorkspaceSessionKey: sessionRead.runtimeHostIdByWorkspaceSessionKey
            })
            actions.hydrateTabsSession(sessionRead.session, sessionHydrationOptions)
            actions.hydrateEditorSession(sessionRead.session, sessionHydrationOptions)
            actions.hydrateBrowserSession(sessionRead.session, sessionHydrationOptions)
          })
          // Why: prune visit timestamps AFTER hydration (earlier, worktreesByRepo may be empty and prune would drop entries for worktrees about to appear); seed the active worktree if missing.
          // See docs/cmd-j-empty-query-ordering.md.
          timeRendererStartupSyncStep('visit-timestamp-prune', () => {
            actions.pruneLastVisitedTimestamps()
            actions.seedActiveWorktreeLastVisitedIfMissing()
          })
          await timeRendererStartupStep('fetch-browser-session-profiles', () =>
            actions.fetchBrowserSessionProfiles()
          )
          const onboardingState = await onboardingPromise
          if (!cancelled) {
            setOnboarding(onboardingState)
            setOnboardingLoaded(true)
          }

          // Why: re-establish SSH before terminal reconnect so SSH-backed tabs route through pty.attach; passphrase targets defer to tab focus to avoid stacked credential dialogs.
          // Why: never dial runtime-owned (ephemeral-VM) targets from the renderer — ssh.connect would dispose the runtime layer's live relay session; filter them out here too.
          const connectionIds = (sessionRead.session.activeConnectionIdsAtShutdown ?? []).filter(
            (targetId) => !isRuntimeOwnedSshTargetId(targetId)
          )
          if (connectionIds.length > 0) {
            try {
              const SSH_RECONNECT_TIMEOUT_MS = 15_000
              const allTargets = await timeRendererStartupStep('ssh-list-targets', () =>
                window.api.ssh.listTargets()
              )
              const targetMap = new Map(allTargets.map((t) => [t.id, t]))
              const targets = connectionIds.map((targetId) => ({
                targetId,
                needsPassphrase: targetMap.get(targetId)?.lastRequiredPassphrase ?? false
              }))

              const eagerTargets = targets.filter((t) => !t.needsPassphrase)
              const deferredTargets = targets.filter((t) => t.needsPassphrase)

              if (deferredTargets.length > 0) {
                actions.setDeferredSshReconnectTargets(deferredTargets.map((t) => t.targetId))
              }

              // Why: treat timed-out eager targets as deferred so their PTYs reattach on tab focus (ssh.connect keeps running in main and likely finishes by then).
              const timedOutTargets: string[] = []
              await timeRendererStartupStep(
                'ssh-reconnect',
                () =>
                  Promise.all(
                    eagerTargets.map(async ({ targetId }) => {
                      const result = await reconnectSshTargetForRendererStartup({
                        targetId,
                        timeoutMs: SSH_RECONNECT_TIMEOUT_MS,
                        connect: (id) => window.api.ssh.connect({ targetId: id }),
                        publishState: actions.setSshConnectionState,
                        onFailure: (id, error) => {
                          console.warn(`SSH auto-reconnect failed for ${id}:`, error)
                        }
                      })
                      if (result.timedOut) {
                        timedOutTargets.push(targetId)
                      }
                    })
                  ),
                {
                  eagerTargets: eagerTargets.length,
                  deferredTargets: deferredTargets.length
                }
              )
              if (timedOutTargets.length > 0) {
                actions.setDeferredSshReconnectTargets([
                  ...deferredTargets.map((t) => t.targetId),
                  ...timedOutTargets
                ])
              }

              // Why: older/wrapped providers may return no state from connect; poll main once as a compatibility fallback before terminal restoration.
              for (const { targetId } of eagerTargets) {
                if (timedOutTargets.includes(targetId)) {
                  continue
                }
                try {
                  const state = await window.api.ssh.getState({ targetId })
                  console.warn(
                    `[ssh-restore] Polled state for ${targetId}: status=${state?.status}`
                  )
                  if (state?.status === 'connected') {
                    actions.setSshConnectionState(targetId, state)
                  }
                } catch {
                  /* best-effort */
                }
              }
            } catch (err) {
              console.warn('SSH startup reconnect failed:', err)
            }
          } else {
            logRendererStartupDiagnostic('ssh-reconnect-skipped', { connectionIds: 0 })
          }

          // Why: main overlaps daemon/hook startup with hydration, but restored terminals need those services ready before they spawn/reconnect PTYs.
          await timeRendererStartupStep('first-window-services-await', () =>
            window.api.app.awaitFirstWindowStartupServices()
          )
          reconnectStarted = true
          await timeRendererStartupStep('reconnect-terminals', () =>
            actions.reconnectPersistedTerminals(abortController.signal)
          )
          syncZoomCSSVar()
          // Why (issue #1158): unlock the session writer only after hydration and all dependent steps succeeded, so a mid-startup throw can't serialize partially-mutated state to disk.
          actions.setHydrationSucceeded(true)
          logRendererStartupDiagnostic('startup-hydration-done', {
            durationMs: Math.round(performance.now() - startupStartedAt)
          })
          void (async () => {
            try {
              try {
                await timeRendererStartupStep('remote-catalog-refresh', async () => {
                  await actions.fetchReposForAllHosts()
                  await actions.fetchProjectGroupsForAllHosts()
                  await actions.fetchFolderWorkspacesForAllHosts()
                })
              } catch (err) {
                console.warn('Remote startup catalog refresh failed:', err)
              }
              if (!cancelled) {
                try {
                  await timeRendererStartupStep('remote-worktree-refresh', async () => {
                    // Why: the full scan is not required for session recovery, so keep it off the startup-critical path.
                    await actions.fetchAllWorktrees()
                    // Why: the startup prune only saw session-referenced repos; use the deferred scan's
                    // authoritative results to drop deleted-worktree visit timestamps that would
                    // otherwise accumulate unbounded (disconnected SSH stays non-authoritative and is kept).
                    actions.pruneLastVisitedTimestamps()
                    await actions.fetchWorktreeLineage()
                  })
                } catch (err) {
                  console.warn('Deferred startup worktree refresh failed:', err)
                }
              }
            } finally {
              if (!cancelled) {
                useAppStore.setState({ startupWorktreeRefreshCompleted: true })
              }
            }
          })()
        }
      } catch (error) {
        // Why (issue #1158): leave in-memory state untouched and keep hydrationSucceeded false (default-hydrating here once erased saved tabs); still flip the ready flags so the UI mounts.
        const stepLabel = error instanceof Error && error.message ? error.message : String(error)
        console.error(
          '[startup] Workspace session hydration failed; leaving disk state untouched:',
          stepLabel,
          error
        )
        if (!cancelled) {
          // Why: degraded mode stays interactive; later repo/runtime changes must not remain gated forever.
          useAppStore.setState({ startupWorktreeRefreshCompleted: true })
          // Why (issue #1158): only apply default UI if ui.get() never hydrated; otherwise defaults would clobber ui.json via the debounced writer.
          const fallbackUI = getStartupErrorFallbackUI(uiHydrated)
          if (fallbackUI) {
            actions.hydratePersistedUI(fallbackUI, 'startup')
          }
          // Why (issue #1158): sticky toast so the user knows they're in degraded "no-save" mode (hydrationSucceeded stays false); "Restart now" calls app.relaunch to recover.
          toast.error(translate('auto.App.12e77cf12b', 'Session restore failed'), {
            description: translate(
              'auto.App.0a9e810705',
              "Changes won't be saved until restart. Your previous tabs are safe on disk."
            ),
            duration: Infinity,
            dismissible: true,
            action: {
              label: translate('auto.App.caea5b51b9', 'Restart now'),
              onClick: () => {
                void window.api.app.relaunch()
              }
            }
          })
          // Why: reconnect flips workspaceSessionReady so the UI mounts, but hydrationSucceeded stays false so the session writer can't overwrite the file we failed to load.
          if (!reconnectStarted) {
            try {
              await window.api.app.awaitFirstWindowStartupServices()
              await actions.reconnectPersistedTerminals(abortController.signal)
            } catch (reconnectErr) {
              console.error(
                '[startup] reconnectPersistedTerminals failed in error path:',
                reconnectErr
              )
              // Why (issue #1158): the await may have run during StrictMode teardown; re-check !cancelled so a cancelled pass 1 doesn't stomp pass 2's hydration.
              if (!cancelled) {
                // Why (issue #1158): recovery threw too; force the flag so the shell still mounts, and clear pending* maps (normally drained by reconnect) to avoid phantom reconnects on dead PTYs.
                useAppStore.setState({
                  workspaceSessionReady: true,
                  pendingReconnectWorktreeIds: [],
                  pendingReconnectTabByWorktree: {},
                  pendingReconnectPtyIdByTabId: {}
                })
              }
            }
          } else {
            // Why (issue #1158): reconnect already started; re-running over its partially-mutated state would double-set ptyIds and drain pending* twice — force the flag, clear pending*.
            useAppStore.setState({
              workspaceSessionReady: true,
              pendingReconnectWorktreeIds: [],
              pendingReconnectTabByWorktree: {},
              pendingReconnectPtyIdByTabId: {}
            })
          }
        }
      }
      void actions.initGitHubCache()
    })()

    return () => {
      cancelled = true
      abortController.abort()
    }
  }, [actions])

  useEffect(() => {
    setRuntimeGraphStoreStateGetter(useAppStore.getState)
    return () => {
      setRuntimeGraphStoreStateGetter(null)
    }
  }, [])

  useEffect(() => {
    let previousKey = getRuntimeMobileSessionSyncKey(useAppStore.getState())
    return useAppStore.subscribe((state, previousState) => {
      // Why: this fires on every store mutation; read the cached prefers-dark snapshot instead of allocating a throwaway MediaQueryList via matchMedia each tick.
      const systemPrefersDark = getSystemPrefersDarkSnapshot()
      // Why: skip the key build when every input is reference-unchanged; the gate mirrors every field getRuntimeMobileSessionSyncKey uses.
      if (
        canSkipRuntimeMobileSessionSyncKeyBuild(
          state,
          previousState,
          systemPrefersDark,
          previousKey.systemPrefersDark
        )
      ) {
        return
      }
      const nextKey = getRuntimeMobileSessionSyncKey(
        state,
        previousState,
        previousKey,
        systemPrefersDark
      )
      if (runtimeMobileSessionSyncKeysEqual(nextKey, previousKey)) {
        return
      }
      previousKey = nextKey
      scheduleRuntimeGraphSync()
    })
  }, [])

  useEffect(() => registerUpdaterBeforeUnloadBypass(), [])

  useEffect(() => {
    setRuntimeGraphSyncEnabled(workspaceSessionReady)
    return () => {
      setRuntimeGraphSyncEnabled(false)
    }
  }, [workspaceSessionReady])

  // Why: session persistence only writes to disk; a Zustand subscribe() outside React drops ~15 render-cycle subscriptions and their re-renders on every tab/file/browser change.
  useEffect(() => {
    return createSessionWriteSubscriber({
      store: useAppStore,
      shouldSchedulePersist: () => !isRemoteWorkspaceSnapshotApplyInProgress(),
      persist: ({ patch }) => {
        const state = useAppStore.getState()
        // Why: route each host's worktree-scoped slice to its own partition; return the local write so the remote-workspace upload chain below keeps its ordering.
        const localWrite = patchWorkspaceSessionByHost(window.api.session, patch, state)
        void localWrite
        const hydratedTargetIds = Array.from(state.remoteWorkspaceHydratedTargetIds).filter(
          (targetId) => state.remoteWorkspaceSyncStatusByTargetId[targetId]?.phase !== 'conflict'
        )
        if (hydratedTargetIds.length > 0) {
          void localWrite
            .then(() => window.api.remoteWorkspace?.setForConnectedTargets({ hydratedTargetIds }))
            .then((results) => {
              for (const { targetId, result } of results ?? []) {
                applyRemoteWorkspacePatchStatus(targetId, result)
              }
            })
            .catch((err) => {
              for (const targetId of hydratedTargetIds) {
                useAppStore.getState().setRemoteWorkspaceSyncStatus(targetId, {
                  phase: 'error',
                  direction: 'push',
                  message: err instanceof Error ? err.message : 'Workspace upload failed'
                })
              }
            })
        }
      }
    })
  }, [])

  // On shutdown, capture terminal scrollback buffers and flush all durable
  // renderer state through one synchronous main-process checkpoint.
  useEffect(() => {
    // Why: beforeunload fires twice during a manual quit — once from the
    // synthetic dispatch in the onWindowCloseRequested handler (captures
    // good data while TerminalPanes are still mounted), and again from the
    // native window close triggered by confirmWindowClose(). Between these
    // two firings, PTY exit events can arrive and unmount TerminalPanes,
    // emptying shutdownBufferCaptures. The guard prevents the second call
    // from overwriting the good session data with an empty snapshot.
    const shutdownCheckpoint = createShutdownCheckpointGuard(() => {
      const shouldCaptureSession = shouldPersistWorkspaceSession(useAppStore.getState())
      if (shouldCaptureSession) {
        for (const capture of shutdownBufferCaptures.values()) {
          try {
            capture({ includeLocalBuffers: false })
          } catch {
            // Don't let one pane's failure block the rest.
          }
        }
        // Why: agent provider session ids live only in agentStatusByPaneKey,
        // which is in-memory. Capture them into the persisted sleeping-session
        // map so a daemon/session death while the app is closed can still
        // cold-restore via the agent's resume command (#5232).
        useAppStore.getState().captureAllSleepingAgentSessions('quit')
      }
      // Why: re-read state after capture() calls populated scrollback buffers
      // into the store via Zustand setters. The earlier read is only for the
      // gating flags and would miss those updates.
      const freshState = useAppStore.getState()
      const sessionSnapshots = shouldCaptureSession
        ? buildWorkspaceSessionHostSnapshots(buildWorkspaceSessionPayload(freshState), freshState)
        : []
      // Why: one blocking checkpoint closes the immediate-quit race for both
      // the narrow view preference and the larger session recovery snapshots.
      window.api.app.persistBeforeUnloadSync({
        sessions: sessionSnapshots,
        ui: buildActiveViewUnloadPatch(freshState)
      })
    })
    const persistBeforeUnload = createShutdownCheckpointBeforeUnloadHandler(shutdownCheckpoint)
    window.addEventListener('beforeunload', persistBeforeUnload)
    window.addEventListener(ORCA_APP_RESTART_ABORTED_EVENT, shutdownCheckpoint.reset)
    window.addEventListener(ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT, shutdownCheckpoint.reset)
    window.addEventListener(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT, shutdownCheckpoint.reset)
    return () => {
      window.removeEventListener('beforeunload', persistBeforeUnload)
      window.removeEventListener(ORCA_APP_RESTART_ABORTED_EVENT, shutdownCheckpoint.reset)
      window.removeEventListener(
        ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT,
        shutdownCheckpoint.reset
      )
      window.removeEventListener(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT, shutdownCheckpoint.reset)
    }
  }, [])

  // Why: beforeunload never fires on a hard kill (crash, forced update, TerminateProcess), so periodically capture agent session ids (not scrollback) so live agents keep a resume record.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!shouldPersistWorkspaceSession(useAppStore.getState())) {
        return
      }
      useAppStore.getState().captureAllSleepingAgentSessions('periodic')
    }, SLEEPING_AGENT_RESUME_CAPTURE_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [])

  // Why: subscribe at the always-mounted App root — Terminal owns the confirm flow but isn't mounted on the landing page, so subscribing there left File→Exit / Ctrl+Q with no listener (#5144).
  useEffect(() => {
    return window.api.ui.onWindowCloseRequested(dispatchWindowCloseRequest)
  }, [])

  // Why no periodic scrollback save: the old 3-min re-serialize (#461) stalled the main thread for seconds; the out-of-process daemon (#729) is the durable replacement, non-daemon users lose in-session scrollback on unexpected exit.

  useEffect(() => {
    if (!persistedUIReady) {
      return
    }

    const timer = window.setTimeout(() => {
      void window.api.ui.set({
        sidebarWidth,
        rightSidebarOpen,
        rightSidebarTab,
        rightSidebarExplorerView,
        rightSidebarWidth,
        markdownTocPanelWidth,
        groupBy,
        sortBy,
        projectOrderBy,
        showActiveOnly: false,
        hideSleepingWorkspaces: !showSleepingWorkspaces,
        showSleepingWorkspaces,
        hideDefaultBranchWorkspace,
        hideAutomationGeneratedWorkspaces,
        showDotfilesByWorktree,
        filterRepoIds,
        // Why (#9002): activeView is deliberately NOT included here. It used to
        // ride this same 150ms writer (#8265), which meant every top-level view
        // switch scheduled a full durable-state save. The narrow preference
        // effect below persists it without touching the recovery snapshot.
        // Why: rides the same debounced save so dashboard auto-acks (which fire
        // on focus/visibility) and the in-memory ack cleanup paths in
        // agent-status.ts (close/dismiss) both flow to disk through map
        // identity changes. Without persisting, agent rows that survive
        // restart come back bold even when the user had already visited them.
        acknowledgedAgentsByPaneKey
      })
    }, 150)

    return () => window.clearTimeout(timer)
  }, [
    persistedUIReady,
    sidebarWidth,
    rightSidebarOpen,
    rightSidebarTab,
    rightSidebarExplorerView,
    rightSidebarWidth,
    markdownTocPanelWidth,
    groupBy,
    sortBy,
    projectOrderBy,
    showSleepingWorkspaces,
    hideDefaultBranchWorkspace,
    hideAutomationGeneratedWorkspaces,
    showDotfilesByWorktree,
    filterRepoIds,
    acknowledgedAgentsByPaneKey
  ])

  // Why (#9002): activeView has its own tiny profile preference, so it can track
  // every switch without scheduling the multi-MB durable-state writer.
  useEffect(() => {
    if (!persistedUIReady) {
      return
    }
    void window.api.ui.set({ activeView })
  }, [activeView, persistedUIReady])

  // Apply theme to document
  useEffect(() => {
    if (!settings) {
      return
    }

    if (settings.theme === 'dark') {
      applyDocumentTheme('dark')
      return undefined
    } else if (settings.theme === 'light') {
      applyDocumentTheme('light')
      return undefined
    } else {
      // system
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      applyDocumentTheme('system')
      const handler = (): void => {
        applyDocumentTheme('system')
        // System theme changes don't mutate the store, so mobile terminal colors need an explicit graph republish.
        scheduleRuntimeGraphSync()
      }
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    }
  }, [settings])

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--app-font-family',
      buildAppFontFamily(settings?.appFontFamily)
    )
  }, [settings?.appFontFamily])

  // Refresh GitHub data (PR/issue status) when window regains focus
  useEffect(() => {
    const handler = (): void => {
      if (document.visibilityState === 'visible') {
        actions.refreshAllGitHub()
        actions.bumpGitHubPRVisibleRefreshGeneration()
      } else {
        actions.reportVisibleGitHubPRRefreshCandidates([], Date.now())
      }
    }
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }, [actions])

  const hasTabBar = tabCount >= 2
  const showTitlebarExpandButton = workspaceChromeActive && !hasTabBar && effectiveActiveTabExpanded
  // Activity/Space are full-page navigation surfaces (like Settings), so the worktree sidebar is hidden there.
  const showSidebar =
    activeView !== 'settings' &&
    activeView !== 'activity' &&
    activeView !== 'space' &&
    activeView !== 'skills'
  // Tasks/Landing show the full titlebar only when the sidebar is collapsed; open, they mirror workspace view (creation suppresses it).
  const stackedSidebarOpen =
    !workspaceChromeActive && !creationLayoutActive && showSidebar && sidebarOpen
  // Visible creation keeps only the top-left window chrome; tabs and right-sidebar chrome stay gated by workspaceChromeActive.
  const leftTitlebarChromeLayout = resolveLeftTitlebarChromeLayout({
    workspaceChromeActive,
    stackedSidebarOpen,
    creationLayoutActive,
    sidebarOpen
  })
  // Full-page navigation surfaces own the whole content area, so suppress right-sidebar controls.
  const showRightSidebarControls = !creationLayoutActive && canShowRightSidebarForView(activeView)
  const showProfileSwitcherInSidebarFooter = showSidebar && sidebarOpen
  const showProfileSwitcherInTopRight = !showProfileSwitcherInSidebarFooter

  const handleToggleExpand = (): void => {
    if (!effectiveActiveTabId) {
      return
    }
    window.dispatchEvent(
      new CustomEvent(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, {
        detail: { tabId: effectiveActiveTabId }
      })
    )
  }

  const globalShortcutStateRef = useRef({
    activeView,
    activeWorktreeId,
    actions,
    floatingTerminalEnabled,
    floatingTerminalOpen,
    floatingVisibleTabCount,
    keybindings,
    terminalShortcutPolicy: settings?.terminalShortcutPolicy,
    setFloatingTerminalOpenWithFocus,
    workspaceChromeActive,
    creationLayoutActive
  })
  // Window key listeners are global and long-lived: one registration, but the handler reads current shortcut state each key event.
  globalShortcutStateRef.current = {
    activeView,
    activeWorktreeId,
    actions,
    floatingTerminalEnabled,
    floatingTerminalOpen,
    floatingVisibleTabCount,
    keybindings,
    terminalShortcutPolicy: settings?.terminalShortcutPolicy,
    setFloatingTerminalOpenWithFocus,
    workspaceChromeActive,
    creationLayoutActive
  }

  useEffect(() => {
    const doubleTapDetector = new ModifierDoubleTapDetector()

    const dispatchShortcutInput = (input: ShortcutDispatchInput): void => {
      const {
        activeView,
        activeWorktreeId,
        actions,
        floatingTerminalEnabled,
        floatingTerminalOpen,
        floatingVisibleTabCount,
        keybindings,
        terminalShortcutPolicy,
        setFloatingTerminalOpenWithFocus,
        workspaceChromeActive,
        creationLayoutActive
      } = globalShortcutStateRef.current

      // Child handlers (e.g. terminal search) share this window capture phase and fire first; bail if they already preventDefault'd so both don't act.
      if (input.defaultPrevented) {
        return
      }
      // The Settings shortcut recorder captures existing shortcuts, so global handlers must not fire while its button has focus.
      if (
        input.target instanceof Element &&
        input.target.closest('[data-shortcut-recorder-active]') !== null
      ) {
        return
      }
      const context = getKeybindingContext(input.target)

      // Note: some shortcuts are also intercepted in createMainWindow.ts before-input-event (for browser-guest focus); the renderer keeps handlers for local focus.

      const matchShortcut = (actionId: KeybindingActionId): boolean =>
        keybindingMatchesAction(actionId, input, shortcutPlatform, keybindings, {
          context,
          terminalShortcutPolicy
        })
      const notifyTerminalCapture = (actionId: KeybindingActionId): void => {
        if (context !== 'terminal' || (terminalShortcutPolicy ?? 'orca-first') !== 'orca-first') {
          return
        }
        showTerminalShortcutCaptureNotification({
          actionId,
          platform: shortcutPlatform,
          keybindings
        })
      }

      const canRevealRightSidebar = !creationLayoutActive && canShowRightSidebarForView(activeView)

      const openSearchSidebar = (query: string | null): void => {
        actions.showRightSidebarSearch(query ? { query } : undefined)
      }

      if (matchShortcut('sidebar.search.toggle') && canRevealRightSidebar) {
        // With a folder selected in the explorer, Cmd/Ctrl+Shift+F means "Find in Folder" — seed the include pattern with it, not a text search.
        const selectedFolderRelativePath =
          document.activeElement instanceof Element
            ? selectedExplorerFolderRelativePath(document.activeElement)
            : null
        if (selectedFolderRelativePath !== null && activeWorktreeId) {
          input.preventDefault()
          notifyTerminalCapture('sidebar.search.toggle')
          actions.showRightSidebarSearch({
            includePattern: folderRelativePathToIncludeGlob(selectedFolderRelativePath)
          })
          return
        }

        const selectedText = getSelectedTextForFileSearch()
        if (selectedText) {
          input.preventDefault()
          notifyTerminalCapture('sidebar.search.toggle')
          openSearchSidebar(selectedText)
          return
        }
      }

      // An empty floating workspace has no tab to close, so Cmd/Ctrl+W hides the overlay before other surfaces act.
      if (
        keybindingMatchesAction('tab.close', input, shortcutPlatform, keybindings, {
          context: 'app'
        }) &&
        shouldMinimizeFloatingWorkspacePanelOnCloseShortcut({
          floatingTerminalOpen,
          floatingVisibleTabCount
        })
      ) {
        input.preventDefault()
        setFloatingTerminalOpenWithFocus(false)
        return
      }

      // Floating panel closed → its keydown handler is gone, so honor the maximize chord here by opening it pre-maximized (no-op while it's open).
      if (
        !floatingTerminalOpen &&
        matchShortcut('floatingWorkspace.maximize') &&
        floatingTerminalEnabled
      ) {
        input.preventDefault()
        requestFloatingTerminalOpenMaximized()
        setFloatingTerminalOpenWithFocus(true)
        return
      }

      // Skip editable surfaces so TipTap's Cmd+B bold works; this renderer-side fallback covers the blur→press IPC race (docs/markdown-cmd-b-bold-design.md).
      if (isEditableTarget(input.target)) {
        return
      }

      // Let floating-terminal SSH/tmux control chords reach the terminal (xterm's helper textarea isn't a generic editable target).
      if (isFloatingWorkspaceTerminalInputTarget(input.target)) {
        return
      }

      // Cmd/Ctrl+Alt+Arrow worktree history — kept before right-sidebar shortcuts because it's navigation, not sidebar reveal.
      if (matchShortcut('worktree.history.back') || matchShortcut('worktree.history.forward')) {
        // Back/Forward is live wherever the titlebar cluster shows (worktree + page visits), but suppressed in Settings.
        if (creationLayoutActive || !shouldShowWorktreeHistoryControls(activeView)) {
          return
        }
        input.preventDefault()
        const store = useAppStore.getState()
        if (matchShortcut('worktree.history.back')) {
          store.goBackWorktree()
        } else {
          store.goForwardWorktree()
        }
        return
      }

      // Only short-circuit chords the floating panel itself claims; suppressing others here would silently no-op them when focus is in the panel.
      const floatingWorkspaceFocused = isFloatingWorkspacePanelFocused()
      if (floatingWorkspaceFocused) {
        if (
          isFloatingWorkspacePanelShortcut(input, shortcutPlatform, null, keybindings, {
            context,
            terminalShortcutPolicy
          })
        ) {
          return
        }
      }

      // Cmd/Ctrl+B — toggle left sidebar
      if (matchShortcut('sidebar.left.toggle')) {
        input.preventDefault()
        notifyTerminalCapture('sidebar.left.toggle')
        actions.toggleSidebar()
        return
      }

      // Toggle the sleeping-workspaces filter without the filters menu (issue #5209); open the sidebar when revealing so they're reachable.
      if (matchShortcut('sidebar.sleepingWorkspaces.toggle')) {
        input.preventDefault()
        notifyTerminalCapture('sidebar.sleepingWorkspaces.toggle')
        const store = useAppStore.getState()
        const nextShowSleeping = !store.showSleepingWorkspaces
        store.setShowSleepingWorkspaces(nextShowSleeping)
        if (nextShowSleeping) {
          store.setSidebarOpen(true)
        }
        return
      }

      // Cmd+R renames the active terminal tab — free here because the browser pane owns its own reload; non-terminal tabs fall through (no inline title editor).
      if (workspaceChromeActive && !floatingWorkspaceFocused && matchShortcut('tab.rename')) {
        const store = useAppStore.getState()
        if (store.activeTabType === 'terminal' && store.activeTabId) {
          input.preventDefault()
          notifyTerminalCapture('tab.rename')
          store.setRenamingTabId(store.activeTabId)
          return
        }
      }

      // Open/reveal the worktree card first so its inline title editor is mounted even when filters or collapse state would hide it.
      if (
        workspaceChromeActive &&
        !floatingWorkspaceFocused &&
        matchShortcut('workspace.rename') &&
        activeWorktreeId
      ) {
        input.preventDefault()
        notifyTerminalCapture('workspace.rename')
        const store = useAppStore.getState()
        store.setSidebarOpen(true)
        requestScrollToCurrentWorkspaceRevealAndRename()
        return
      }

      if (matchShortcut('workspace.openBoard') && activeView !== 'settings') {
        input.preventDefault()
        notifyTerminalCapture('workspace.openBoard')
        const store = useAppStore.getState()
        store.setSidebarOpen(true)
        window.dispatchEvent(new CustomEvent(OPEN_WORKSPACE_BOARD_EVENT))
        return
      }

      // Cmd/Ctrl+N is handled in the main-process before-input-event allowlist (window-shortcut-policy.ts), not here, so it fires even inside editors/browser guests.

      // Full-page navigation surfaces own the whole content area, so don't reveal the right sidebar.
      if (matchShortcut('view.tasks') && activeView !== 'settings') {
        const store = useAppStore.getState()
        if (store.repos.some((repo) => isGitRepoKind(repo))) {
          input.preventDefault()
          notifyTerminalCapture('view.tasks')
          store.openTaskPage()
        }
        return
      }

      if (!canRevealRightSidebar) {
        return
      }

      // Cmd/Ctrl+L — toggle right sidebar
      if (matchShortcut('sidebar.right.toggle')) {
        input.preventDefault()
        notifyTerminalCapture('sidebar.right.toggle')
        actions.toggleRightSidebar()
        return
      }

      // Cmd/Ctrl+Shift+E — toggle right sidebar / explorer tab
      if (matchShortcut('sidebar.explorer.toggle')) {
        input.preventDefault()
        notifyTerminalCapture('sidebar.explorer.toggle')
        actions.showRightSidebarFiles()
        return
      }

      // Cmd/Ctrl+Shift+F — toggle right sidebar / search tab
      if (matchShortcut('sidebar.search.toggle')) {
        input.preventDefault()
        notifyTerminalCapture('sidebar.search.toggle')
        openSearchSidebar(null)
        return
      }

      // Cmd/Ctrl+Shift+G — source control tab; skip when terminal search is open (there it means "find previous"). DOM check because capture-phase order varies.
      if (matchShortcut('sidebar.sourceControl.toggle')) {
        if (document.querySelector('[data-terminal-search-root]')) {
          return
        }
        input.preventDefault()
        notifyTerminalCapture('sidebar.sourceControl.toggle')
        actions.setRightSidebarTab('source-control')
        actions.setRightSidebarOpen(true)
        return
      }

      // Unbound by default; opens the active worktree's Source Control notes send picker. Only consumes the chord when there are unsent notes.
      if (matchShortcut('sourceControl.sendReviewNotes')) {
        if (actions.openDiffNotesSendMenuForActiveWorktree()) {
          input.preventDefault()
          notifyTerminalCapture('sourceControl.sendReviewNotes')
          return
        }
      }

      if (matchShortcut('sidebar.checks.toggle')) {
        input.preventDefault()
        notifyTerminalCapture('sidebar.checks.toggle')
        actions.setRightSidebarTab('checks')
        actions.setRightSidebarOpen(true)
        return
      }

      // Cmd+Shift+I — ports tab (macOS only); Ctrl+Shift+I is the DevTools accelerator on Windows/Linux.
      if (matchShortcut('sidebar.ports.toggle')) {
        input.preventDefault()
        notifyTerminalCapture('sidebar.ports.toggle')
        actions.setRightSidebarTab('ports')
        actions.setRightSidebarOpen(true)
      }
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      const detected = doubleTapDetector.process(
        toModifierDoubleTapEvent({
          type: 'keyDown',
          code: e.code,
          key: e.key,
          shift: e.shiftKey,
          control: e.ctrlKey,
          alt: e.altKey,
          meta: e.metaKey,
          isAutoRepeat: e.repeat
        }),
        Date.now()
      )
      if (e.repeat) {
        return
      }
      if (detected) {
        // Synthetic input: no key/modifier flags, so only DoubleTap bindings match.
        dispatchShortcutInput({
          doubleTapModifier: detected.modifier,
          target: e.target,
          defaultPrevented: e.defaultPrevented,
          preventDefault: () => e.preventDefault()
        })
        return
      }
      dispatchShortcutInput({
        key: e.key,
        code: e.code,
        altKey: e.altKey,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        target: e.target,
        defaultPrevented: e.defaultPrevented,
        preventDefault: () => e.preventDefault()
      })
    }

    const onKeyUp = (e: KeyboardEvent): void => {
      doubleTapDetector.process(
        toModifierDoubleTapEvent({
          type: 'keyUp',
          code: e.code,
          key: e.key,
          shift: e.shiftKey,
          control: e.ctrlKey,
          alt: e.altKey,
          meta: e.metaKey
        }),
        Date.now()
      )
    }

    // Why: a window blur mid-gesture must not leave the detector armed.
    const onBlur = (): void => doubleTapDetector.reset()

    window.addEventListener('keydown', onKeyDown, { capture: true })
    window.addEventListener('keyup', onKeyUp, { capture: true })
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      window.removeEventListener('keyup', onKeyUp, { capture: true })
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  useLayoutEffect(() => {
    const controls = titlebarLeftControlsRef.current
    if (!controls) {
      return
    }

    const updateWidth = (): void => {
      setCollapsedSidebarHeaderWidth(controls.getBoundingClientRect().width)
    }

    updateWidth()
    const observer = new ResizeObserver(() => {
      updateWidth()
    })
    observer.observe(controls)
    return () => observer.disconnect()
  }, [
    isFullScreen,
    settings?.showTitlebarAppName,
    showSidebar,
    leftTitlebarChromeLayout.isFloating,
    sidebarOpen
  ])

  const resolvedMountedLazyModalIds = resolveMountedLazyModalIds(activeModal, mountedLazyModalIds)
  if (resolvedMountedLazyModalIds !== mountedLazyModalIds) {
    // Why: lazy-load modals on first use, then keep them mounted so repeat opens preserve state and avoid re-fetch flashes.
    setMountedLazyModalIds(new Set(resolvedMountedLazyModalIds))
  }

  // Why: extracted so the full-width titlebar and the sidebar-width left header share these controls without duplicating the agent badge popover.
  const titlebarLeftControls = (
    // Why: measure the ENTIRE row so TabGroupPanel's collapse spacer reserves enough width; measuring only the inner cluster left back/forward over the first tab.
    // Why: collapsed mode floats in a w-0 wrapper; w-max stops Windows Chromium from shrinking the app name to one glyph.
    <div
      ref={titlebarLeftControlsRef}
      className={`flex h-full shrink-0 items-center${
        leftTitlebarChromeLayout.isFloating ? ' w-max' : ' w-full'
      }`}
    >
      <div className="flex h-full items-center">
        {isMac && !isFullScreen ? (
          <div className="titlebar-traffic-light-pad" />
        ) : hasCustomTitleBar ? (
          /* Why: Windows/Linux remove the native title bar, so render the logo plus a ··· button that pops the application menu (as Alt does). */
          <>
            <img src={logo} alt="" aria-hidden className="titlebar-logo" />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="titlebar-icon-button"
                  aria-label={translate('auto.App.8b0b8eb54f', 'Application menu')}
                  onClick={() => window.api.ui.popupMenu()}
                >
                  <MoreHorizontal size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {translate('auto.App.8b0b8eb54f', 'Application menu')}
              </TooltipContent>
            </Tooltip>
          </>
        ) : (
          <div className="pl-2" />
        )}
        {showSidebar && !hasCustomTitleBar && (
          <>
            {settings?.showTitlebarAppName !== false && (
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <div
                    className="titlebar-app-name"
                    aria-label={translate('auto.App.5096cbbc86', 'Orca')}
                  >
                    <span className="titlebar-app-name-main">
                      {translate('auto.App.5096cbbc86', 'Orca')}
                    </span>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem
                    onSelect={() => {
                      void actions.updateSettings({ showTitlebarAppName: false })
                    }}
                  >
                    {translate('auto.App.e81217c1b7', 'Hide App Name')}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            )}
          </>
        )}
        {showSidebar && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="sidebar-toggle"
                onClick={actions.toggleSidebar}
                aria-label={translate('auto.App.e4b9e7dff7', 'Toggle sidebar')}
              >
                <PanelLeft size={16} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.App.ce37cf5279', 'Toggle sidebar ({{value0}})', {
                value0: leftSidebarShortcutLabel
              })}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      {/* Why: Back/Forward span worktree + page history, so show the cluster wherever the shortcut is live (hidden in Settings/non-stack views). */}
      {shouldShowWorktreeHistoryControls(activeView) && (
        // With the sidebar collapsed the header shrink-wraps and ml-auto has no spare width, so keep a fixed gutter before Back.
        <div className="ml-auto mr-3 flex items-center pl-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="sidebar-toggle sidebar-toggle-compact"
                onClick={() => useAppStore.getState().goBackWorktree()}
                disabled={!canGoBackWorktree}
                aria-label={translate('auto.App.064bd07810', 'Go back')}
              >
                <ArrowLeft size={12} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.App.fe21e8f6f5', 'Go back ({{value0}})', {
                value0: historyBackShortcutLabel
              })}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="sidebar-toggle sidebar-toggle-compact"
                onClick={() => useAppStore.getState().goForwardWorktree()}
                disabled={!canGoForwardWorktree}
                aria-label={translate('auto.App.cf9099fe98', 'Go forward')}
              >
                <ArrowRight size={12} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.App.f7aa73e785', 'Go forward ({{value0}})', {
                value0: historyForwardShortcutLabel
              })}
            </TooltipContent>
          </Tooltip>
        </div>
      )}
    </div>
  )

  const rightSidebarToggle = showRightSidebarControls ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className="sidebar-toggle mr-2"
          onClick={actions.toggleRightSidebar}
          aria-label={translate('auto.App.9e0b441a91', 'Toggle right sidebar')}
        >
          <PanelRight size={16} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {translate('auto.App.c184e056de', 'Toggle right sidebar ({{value0}})', {
          value0: rightSidebarShortcutLabel
        })}
      </TooltipContent>
    </Tooltip>
  ) : null

  const titlebarMainStrip = (
    <>
      {activeView === 'activity' ? (
        <ActivityTitlebarControls />
      ) : creationLayoutActive ? null : (
        <div
          id="titlebar-tabs"
          className={`flex flex-1 min-w-0 self-stretch${!workspaceChromeActive ? ' invisible pointer-events-none' : ''}`}
        />
      )}
      {showTitlebarExpandButton && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className="titlebar-icon-button"
              onClick={handleToggleExpand}
              aria-label={translate('auto.App.c1cf0b0e4a', 'Collapse pane')}
              disabled={!activeTabCanExpand}
            >
              <Minimize2 size={14} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate('auto.App.c1cf0b0e4a', 'Collapse pane')}
          </TooltipContent>
        </Tooltip>
      )}
      {showProfileSwitcherInTopRight ? <OrcaProfileSwitcher /> : null}
      {/* Why: the open right sidebar's header renders its own close button, so hide this duplicate. */}
      {!rightSidebarOpen && rightSidebarToggle}
      {/* Why: reserve space so the Windows/Linux window-controls overlay doesn't obscure content. */}
      {hasCustomTitleBar && <div className="window-controls-titlebar-spacer" />}
    </>
  )
  const workspaceProfileSwitcher =
    showProfileSwitcherInTopRight &&
    workspaceChromeActive &&
    leftTitlebarChromeLayout.shouldMount &&
    !stackedSidebarOpen ? (
      <div
        className="absolute top-0 z-10 flex h-[36px] items-center"
        style={
          {
            right: showRightSidebarControls
              ? 'calc(var(--window-controls-width) + 42px)'
              : 'var(--window-controls-width)',
            WebkitAppRegion: 'no-drag'
          } as React.CSSProperties
        }
      >
        <OrcaProfileSwitcher />
      </div>
    ) : null

  return (
    <div
      ref={setAppRootNode}
      className="flex flex-col h-dvh w-screen overflow-hidden"
      style={
        {
          '--collapsed-sidebar-header-width': `${collapsedSidebarHeaderWidth}px`,
          // Shared so surfaces can avoid the Windows/Linux window-controls overlay without hardcoding 138px everywhere.
          '--window-controls-width': hasCustomTitleBar ? '138px' : '0px',
          // Side-position activity bar uses this to push icons below the Windows/Linux window-controls overlay.
          '--window-controls-height': hasCustomTitleBar ? '36px' : '0px'
        } as React.CSSProperties
      }
    >
      <TooltipProvider delayDuration={400}>
        <ConfirmationDialogProvider>
          <LinkRoutingPreferenceDialogProvider>
            <WorkspacePortScanner enabled={workspaceSessionReady} />
            {/* Why: leaf-mounted retention sync keeps agent-status subscriptions out of the App render tree. */}
            <RetainedAgentsSyncGate />
            <AgentHibernationGate />
            {/* Why: workspace activation is a hot path; activeWorktreeId in reset keys would remount whole surfaces during wake. */}
            <RecoverableRenderErrorBoundary
              boundaryId="app.workspace-shell"
              surface="workspace-shell"
              resetKey={activeView}
              title={translate('auto.App.df1d56bf87', 'The workspace shell hit an error.')}
              description={translate(
                'auto.App.8504ddf267',
                'The app is still running. Retry the shell or use the menu to report the crash details.'
              )}
            >
              <div className="flex flex-row flex-1 min-h-0 overflow-hidden">
                {/* Why: keep the non-workspace titlebar inside this left+center wrapper so it doesn't span over the right-sidebar column. */}
                <div className="flex flex-col flex-1 min-w-0 min-h-0">
                  {/* Why: workspace view drops the full-width titlebar so tab groups extend to the top; settings/landing/tasks keep it. */}
                  {!leftTitlebarChromeLayout.shouldMount ? (
                    <div className="titlebar">
                      <div className="flex items-center shrink-0 mr-2">{titlebarLeftControls}</div>
                      {titlebarMainStrip}
                    </div>
                  ) : null}
                  <div className="flex flex-row flex-1 min-h-0 overflow-hidden">
                    {showSidebar ? (
                      leftTitlebarChromeLayout.shouldMount ? (
                        /* Why: when the sidebar is collapsed, take this titlebar-height header out of flex layout so the terminal/editor reclaim the left edge. */
                        <div
                          className={`flex min-h-0 flex-col shrink-0${sidebarOpen ? '' : ' relative w-0 overflow-visible'}`}
                        >
                          <div
                            // Why: floating titlebar-left occludes the center column's border-l seam; border-r restores that line, w-max sizes it to its own controls.
                            className={`titlebar-left${
                              leftTitlebarChromeLayout.isFloating
                                ? ' titlebar-left-floating absolute top-0 left-0 z-10 w-max border-r border-border'
                                : ''
                            }`}
                            style={{
                              // Why: custom sidebar appearances are scoped to the sidebar root; mirror those vars onto the header in the same left-column panel.
                              ...(sidebarOpen ? leftSidebarStyle : undefined),
                              // Why: size from the wrapper's live width so the header tracks in-flight drag resizes (persisted to Zustand only on mouseup).
                              width: sidebarOpen ? '100%' : undefined
                            }}
                          >
                            {titlebarLeftControls}
                          </div>
                          <div className="flex min-h-0 flex-1">
                            {/* Why: flex-1/min-h-0 slot needed under the fixed 36px header, else the sidebar collapses to content height and loses its scroll viewport. */}
                            <RecoverableRenderErrorBoundary
                              boundaryId="sidebar.worktrees"
                              surface="sidebar"
                              resetKey={activeView}
                              title={translate(
                                'auto.App.1468601e7b',
                                'The workspace list hit an error.'
                              )}
                              description={translate(
                                'auto.App.bdc71dddc9',
                                'The active workspace remains open. Retry the list or switch views.'
                              )}
                            >
                              <Sidebar
                                worktreeScrollOffsetRef={worktreeSidebarScrollOffsetRef}
                                worktreeScrollAnchorRef={worktreeSidebarScrollAnchorRef}
                              />
                            </RecoverableRenderErrorBoundary>
                          </div>
                        </div>
                      ) : (
                        <RecoverableRenderErrorBoundary
                          boundaryId="sidebar.worktrees"
                          surface="sidebar"
                          resetKey={activeView}
                          title={translate(
                            'auto.App.1468601e7b',
                            'The workspace list hit an error.'
                          )}
                          description={translate(
                            'auto.App.cba0fafda5',
                            'The active page remains open. Retry the list or switch views.'
                          )}
                        >
                          <Sidebar
                            worktreeScrollOffsetRef={worktreeSidebarScrollOffsetRef}
                            worktreeScrollAnchorRef={worktreeSidebarScrollAnchorRef}
                          />
                        </RecoverableRenderErrorBoundary>
                      )
                    ) : null}
                    <div className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden">
                      {stackedSidebarOpen ? (
                        <div className="titlebar">{titlebarMainStrip}</div>
                      ) : null}
                      <div className="relative flex flex-1 min-w-0 min-h-0 overflow-hidden">
                        {/* Why: match the RightSidebar header's 36px/top-0 so the toggle's vertical center is identical open vs closed — else the icon jitters. */}
                        {workspaceChromeActive && !rightSidebarOpen && (
                          <div
                            className="absolute top-0 z-10 flex items-center h-[36px]"
                            style={
                              {
                                // Why: --window-controls-width keeps the toggle clear of the fixed window-controls overlay (138px on custom chrome, 0px otherwise); no internal spacer — one would cover the pane-actions Ellipsis button with an unclickable div.
                                right: 'var(--window-controls-width)',
                                WebkitAppRegion: 'no-drag'
                              } as React.CSSProperties
                            }
                          >
                            {rightSidebarToggle}
                          </div>
                        )}
                        {workspaceProfileSwitcher}
                        <div className="flex flex-1 min-w-0 min-h-0 flex-col">
                          {shouldMountTerminalWorkbench ? (
                            <div
                              className={
                                !terminalWorkbenchVisible
                                  ? 'hidden flex-1 min-w-0 min-h-0'
                                  : 'flex flex-1 min-w-0 min-h-0'
                              }
                            >
                              <Suspense fallback={null}>
                                <RecoverableRenderErrorBoundary
                                  boundaryId="terminal.workbench"
                                  surface="terminal-workbench"
                                  resetKey="terminal"
                                  title={translate(
                                    'auto.App.5a9519aef0',
                                    'The workspace workbench hit an error.'
                                  )}
                                  description={translate(
                                    'auto.App.98d4ea2823',
                                    'Terminal, browser, or editor rendering failed in this workspace. Retry to remount it.'
                                  )}
                                >
                                  <Terminal />
                                </RecoverableRenderErrorBoundary>
                              </Suspense>
                            </div>
                          ) : null}
                          <Suspense fallback={null}>
                            <RecoverableRenderErrorBoundary
                              boundaryId={`page.${activeView}`}
                              surface="page"
                              resetKey={activeView}
                              title={translate('auto.App.b7a714db1e', 'This page hit an error.')}
                              description={translate(
                                'auto.App.03a14f6b5b',
                                'Retry the page or navigate to another Orca surface.'
                              )}
                            >
                              {activeView === 'settings' ? <Settings /> : null}
                              {activeView === 'skills' ? <SkillsPage /> : null}
                              {activeView === 'tasks' ? <TaskPage /> : null}
                              {activeView === 'automations' ? <AutomationsPage /> : null}
                              {activeView === 'activity' ? <ActivityPrototypePage /> : null}
                              {activeView === 'space' ? <WorkspaceSpacePage /> : null}
                              {activeView === 'mobile' ? <MobilePage /> : null}
                              {activeView === 'terminal' &&
                              creationLayoutActive &&
                              activePendingCreationId ? (
                                <WorktreeCreationPanel
                                  creationId={activePendingCreationId}
                                  reserveCollapsedSidebarHeaderSpace={
                                    leftTitlebarChromeLayout.isFloating
                                  }
                                />
                              ) : null}
                              {activeView === 'terminal' &&
                              !activeWorktreeId &&
                              !creationLayoutActive ? (
                                <Landing />
                              ) : null}
                            </RecoverableRenderErrorBoundary>
                          </Suspense>
                        </div>
                        {showFloatingTerminalButton ? (
                          <FloatingTerminalToggleButton
                            open={floatingTerminalOpen}
                            onToggle={() => setFloatingTerminalOpenWithFocus((open) => !open)}
                          />
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
                {/* Why: keep the shell mounted for layout stability (heavy panels disconnect while closed); unmount on the distraction-free tasks view. */}
                {showRightSidebarControls ? (
                  <RecoverableRenderErrorBoundary
                    boundaryId="right-sidebar"
                    surface="right-sidebar"
                    resetKey={
                      rightSidebarTab === 'explorer'
                        ? `${rightSidebarTab}:${rightSidebarExplorerView}`
                        : rightSidebarTab
                    }
                    title={translate('auto.App.ed6b168d00', 'The right sidebar hit an error.')}
                    description={translate(
                      'auto.App.8d1e160ed1',
                      'Retry the sidebar or switch tabs to reload this surface.'
                    )}
                  >
                    <RightSidebar />
                  </RecoverableRenderErrorBoundary>
                ) : null}
              </div>
            </RecoverableRenderErrorBoundary>
            {shouldMountFloatingTerminalPanel ? (
              <Suspense fallback={null}>
                <RecoverableRenderErrorBoundary
                  boundaryId="overlay.floating-workspace"
                  surface="overlay"
                  resetKey={floatingTerminalOpen}
                  compact
                  title={translate('auto.App.1b3024bcd6', 'The floating workspace hit an error.')}
                  description={translate(
                    'auto.App.7cbfbf622f',
                    'Retry the floating workspace or close and reopen it.'
                  )}
                >
                  <FloatingTerminalPanel
                    open={floatingTerminalOpen}
                    onOpenChange={setFloatingTerminalOpenWithFocus}
                    tourInteractionSnapshot={floatingWorkspaceTourInteractionSnapshotRef.current}
                  />
                </RecoverableRenderErrorBoundary>
              </Suspense>
            ) : null}
            {statusBarVisible ? (
              <Suspense
                fallback={
                  <div className="h-6 min-h-[24px] shrink-0 border-t border-border bg-[var(--bg-titlebar,var(--card))]" />
                }
              >
                <RecoverableRenderErrorBoundary
                  boundaryId="overlay.status-bar"
                  surface="overlay"
                  resetKey={activeView}
                  compact
                  title={translate('auto.App.2e8ff36f94', 'The status bar hit an error.')}
                  description={translate(
                    'auto.App.8a023cea1f',
                    'Retry the status bar to remount its controls.'
                  )}
                >
                  <StatusBar floatingTerminalOpen={floatingTerminalOpen} />
                </RecoverableRenderErrorBoundary>
              </Suspense>
            ) : null}
            {/* Why: keep in the entry bundle so a stale/corrupt lazy chunk can't strand users at Create. */}
            {activeModal === 'new-workspace-composer' ? (
              <RecoverableRenderErrorBoundary
                boundaryId="modal.new-workspace-composer"
                surface="modal"
                resetKey
                compact
              >
                <NewWorkspaceComposerModal />
              </RecoverableRenderErrorBoundary>
            ) : null}
            <Suspense fallback={null}>
              {shouldMountAddRepoDialog ? (
                <RecoverableRenderErrorBoundary
                  boundaryId="modal.add-repo"
                  surface="modal"
                  resetKey={activeModal === 'add-repo'}
                  compact
                >
                  <AddRepoDialog />
                </RecoverableRenderErrorBoundary>
              ) : null}
              {/* Why: Settings can start Add Project without Sidebar, so its handoff dialogs must share the root host. */}
              {activeModal === 'confirm-non-git-folder' ? (
                <RecoverableRenderErrorBoundary
                  boundaryId="modal.confirm-non-git-folder"
                  surface="modal"
                  resetKey
                  compact
                >
                  <NonGitFolderDialog />
                </RecoverableRenderErrorBoundary>
              ) : null}
              {activeModal === 'confirm-add-project-from-folder' ? (
                <RecoverableRenderErrorBoundary
                  boundaryId="modal.confirm-add-project-from-folder"
                  surface="modal"
                  resetKey
                  compact
                >
                  <AddProjectFromFolderDialog />
                </RecoverableRenderErrorBoundary>
              ) : null}
              {activeModal === 'project-added' ? (
                <RecoverableRenderErrorBoundary
                  boundaryId="modal.project-added"
                  surface="modal"
                  resetKey
                  compact
                >
                  <ProjectAddedDialog />
                </RecoverableRenderErrorBoundary>
              ) : null}
            </Suspense>
            {/* Why: root overlays can render Radix <Tooltip>s; keep inside the shared provider so lazy surfaces mount from any entry point. */}
            <Suspense fallback={null}>
              {resolvedMountedLazyModalIds.has('workspace-cleanup') ? (
                <RecoverableRenderErrorBoundary
                  boundaryId="modal.workspace-cleanup"
                  surface="modal"
                  resetKey={activeModal === 'workspace-cleanup'}
                  compact
                >
                  <WorkspaceCleanupDialog />
                </RecoverableRenderErrorBoundary>
              ) : null}
            </Suspense>
            <Suspense fallback={null}>
              {resolvedMountedLazyModalIds.has('quick-open') ? (
                <RecoverableRenderErrorBoundary
                  boundaryId="modal.quick-open"
                  surface="modal"
                  resetKey={activeModal === 'quick-open'}
                  compact
                >
                  <QuickOpen />
                </RecoverableRenderErrorBoundary>
              ) : null}
              {resolvedMountedLazyModalIds.has('worktree-palette') ? (
                <RecoverableRenderErrorBoundary
                  boundaryId="modal.worktree-palette"
                  surface="modal"
                  resetKey={activeModal === 'worktree-palette'}
                  compact
                >
                  <WorktreeJumpPalette />
                </RecoverableRenderErrorBoundary>
              ) : null}
              {resolvedMountedLazyModalIds.has('setup-guide') ? (
                <RecoverableRenderErrorBoundary
                  boundaryId="modal.setup-guide"
                  surface="modal"
                  resetKey={activeModal === 'setup-guide'}
                  compact
                >
                  <SetupGuideModal />
                </RecoverableRenderErrorBoundary>
              ) : null}
              {resolvedMountedLazyModalIds.has('feature-wall') ? (
                <RecoverableRenderErrorBoundary
                  boundaryId="modal.feature-wall"
                  surface="modal"
                  resetKey={activeModal === 'feature-wall'}
                  compact
                >
                  <FeatureWallModal />
                </RecoverableRenderErrorBoundary>
              ) : null}
              {resolvedMountedLazyModalIds.has('feature-tips') ? (
                <RecoverableRenderErrorBoundary
                  boundaryId="modal.feature-tips"
                  surface="modal"
                  resetKey={activeModal === 'feature-tips'}
                  compact
                >
                  <FeatureTipsModal />
                </RecoverableRenderErrorBoundary>
              ) : null}
            </Suspense>
            {shouldMountSetupGuideTelemetryObserver ? (
              <Suspense fallback={null}>
                <SetupGuideTelemetryObserver />
              </Suspense>
            ) : null}
            {shouldMountContextualTourOverlay ? (
              <Suspense fallback={null}>
                <ContextualTourOverlay />
              </Suspense>
            ) : null}
            {/* Why: mount only after UI hydration, else a hidden pet flashes while the store still holds default visibility. */}
            {renderPetOverlay ? (
              <Suspense fallback={null}>
                <RecoverableRenderErrorBoundary
                  boundaryId="overlay.pet"
                  surface="overlay"
                  resetKey={petVisible}
                  compact
                >
                  <PetOverlay />
                </RecoverableRenderErrorBoundary>
              </Suspense>
            ) : null}
            {shouldMountUpdateCard ? (
              <Suspense fallback={null}>
                <RecoverableRenderErrorBoundary
                  boundaryId="overlay.update-card"
                  surface="overlay"
                  resetKey={activeView}
                  compact
                >
                  <UpdateCard />
                </RecoverableRenderErrorBoundary>
              </Suspense>
            ) : null}
            <RecoverableRenderErrorBoundary
              boundaryId="overlay.star-nag"
              surface="overlay"
              resetKey={activeView}
              compact
            >
              <StarNagCard />
            </RecoverableRenderErrorBoundary>
            <RecoverableRenderErrorBoundary
              boundaryId="overlay.star-nag-toast"
              surface="overlay"
              resetKey={activeView}
              compact
            >
              <StarNagToastHost />
            </RecoverableRenderErrorBoundary>
            <StarNagAgentValueMomentObserver />
            {/* Why: mount at App root to render once per session; internal cohort gate limits it to pre-telemetry users — see telemetry-plan.md §First-launch experience. */}
            <RecoverableRenderErrorBoundary
              boundaryId="overlay.telemetry-first-launch"
              surface="overlay"
              resetKey={settings?.telemetry?.optedIn ?? 'unknown'}
              compact
            >
              <TelemetryFirstLaunchSurface />
            </RecoverableRenderErrorBoundary>
            <RecoverableRenderErrorBoundary
              boundaryId="overlay.zoom"
              surface="overlay"
              resetKey={activeView}
              compact
            >
              <ZoomOverlay />
            </RecoverableRenderErrorBoundary>
            <Suspense fallback={null}>
              {activeModal === 'delete-worktree' ? (
                <RecoverableRenderErrorBoundary
                  boundaryId="modal.delete-worktree"
                  surface="modal"
                  resetKey
                  compact
                >
                  <DeleteWorktreeDialog />
                </RecoverableRenderErrorBoundary>
              ) : null}
            </Suspense>
            {hasSshCredentialRequest ? (
              <Suspense fallback={null}>
                <RecoverableRenderErrorBoundary
                  boundaryId="modal.ssh-passphrase"
                  surface="modal"
                  resetKey={activeModal}
                  compact
                >
                  <SshPassphraseDialog />
                </RecoverableRenderErrorBoundary>
              </Suspense>
            ) : null}
            <RecoverableRenderErrorBoundary
              boundaryId="modal.markdown-template-picker"
              surface="modal"
              resetKey={activeModal}
              compact
            >
              <MarkdownTemplatePicker />
            </RecoverableRenderErrorBoundary>
            <RecoverableRenderErrorBoundary
              boundaryId="modal.crash-report"
              surface="modal"
              reportAsCrash={false}
              resetKey={activeModal}
              compact
              title={translate('auto.App.722d03aa62', 'The crash report dialog hit an error.')}
              description={translate(
                'auto.App.acd66311dc',
                'Use the Help menu after retrying if you still need diagnostics.'
              )}
            >
              <CrashReportDialog />
            </RecoverableRenderErrorBoundary>
            {onboarding && shouldRenderOnboarding && !onboardingSettingsDetourActive ? (
              <Suspense fallback={null}>
                <RecoverableRenderErrorBoundary
                  boundaryId="modal.onboarding"
                  surface="modal"
                  resetKey={onboardingSettingsDetourActive}
                  title={translate('auto.App.f02d37278a', 'Onboarding hit an error.')}
                  description={translate(
                    'auto.App.221a95ba38',
                    'Retry onboarding or close it and continue in the app.'
                  )}
                >
                  <OnboardingFlow
                    onboarding={onboarding}
                    onOnboardingChange={setOnboarding}
                    onSettingsDetourStart={beginOnboardingSettingsDetour}
                  />
                </RecoverableRenderErrorBoundary>
              </Suspense>
            ) : null}
            {shouldMountDictationController ? (
              <Suspense fallback={null}>
                <RecoverableRenderErrorBoundary
                  boundaryId="overlay.dictation"
                  surface="overlay"
                  resetKey={activeView}
                  compact
                >
                  <DictationController />
                </RecoverableRenderErrorBoundary>
              </Suspense>
            ) : null}
            <RecoverableRenderErrorBoundary
              boundaryId="overlay.recent-tab-switcher"
              surface="overlay"
              resetKey={activeView}
              compact
            >
              <RecentTabSwitcher />
            </RecoverableRenderErrorBoundary>
            {/* Why: hosts a live terminal pane needing the link-routing preference context; mounting outside crashes it. */}
            <RecoverableRenderErrorBoundary
              boundaryId="overlay.skill-freshness-update-dialog"
              surface="overlay"
              compact
            >
              <SkillFreshnessUpdateDialog />
            </RecoverableRenderErrorBoundary>
            <Suspense fallback={null}>
              <RecoverableRenderErrorBoundary
                boundaryId="overlay.remote-server-update-dialog"
                surface="overlay"
                compact
              >
                <RemoteServerUpdateDialog />
              </RecoverableRenderErrorBoundary>
            </Suspense>
          </LinkRoutingPreferenceDialogProvider>
        </ConfirmationDialogProvider>
      </TooltipProvider>
      <Toaster closeButton toastOptions={{ className: 'font-sans text-sm' }} />
      <SkillFreshnessNudge />
      <PinnedTabCloseDialog />
      {/* Why: Electron's drag-region hit-test is DOM-order-based (ignores z-index); render last so WindowControls stay clickable. */}
      {hasCustomTitleBar && <WindowControls />}
    </div>
  )
}

export default App
