/* eslint-disable max-lines */
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction
} from 'react'

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
import { useShallow } from 'zustand/react/shallow'
import { isRemoteWorkspaceSnapshotApplyInProgress, useIpcEvents } from './hooks/useIpcEvents'
import { useAutomationDispatchEvents } from './hooks/useAutomationDispatchEvents'
import RetainedAgentsSyncGate from './components/dashboard/RetainedAgentsSyncGate'
import { AgentHibernationGate } from './components/AgentHibernationGate'
import { ActivityTitlebarControls } from './components/activity/ActivityTitlebarControls'
import Sidebar from './components/Sidebar'
import { shutdownBufferCaptures } from './components/terminal-pane/shutdown-buffer-captures'
import { dispatchWindowCloseRequest } from './components/window-close-request-coordinator'
import { useSystemPrefersDark } from './components/terminal-pane/use-system-prefers-dark'
import RightSidebar from './components/right-sidebar'
import { StarNagCard } from './components/StarNagCard'
import { StarNagAgentValueMomentObserver } from './components/star-nag/StarNagAgentValueMomentObserver'
import { StarNagToastHost } from './components/star-nag/StarNagToastHost'
import { TelemetryFirstLaunchSurface } from './components/TelemetryFirstLaunchSurface'
import { ZoomOverlay } from './components/ZoomOverlay'
import { onOnboardingReopened } from './components/onboarding/show-onboarding-event'
import { shouldShowOnboarding } from './components/onboarding/should-show-onboarding'
import { MarkdownTemplatePicker } from './components/editor/MarkdownTemplatePicker'
import { FloatingTerminalToggleButton } from './components/floating-terminal/FloatingTerminalToggleButton'
import { TOGGLE_FLOATING_TERMINAL_EVENT } from '@/lib/floating-terminal'
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
import { useUnreadDockBadge } from './hooks/useUnreadDockBadge'
import {
  resolvePrimarySelectionMiddleClickPaste,
  usePrimarySelectionPaste
} from './hooks/usePrimarySelectionPaste'
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
  buildWorkspaceSessionPayload,
  shouldPersistWorkspaceSession
} from './lib/workspace-session'
import { createSessionWriteSubscriber } from './lib/session-write-subscriber'
import {
  fetchWorkspaceSessionFromHosts,
  patchWorkspaceSessionByHost,
  persistWorkspaceSessionByHostSync
} from './lib/workspace-session-host-persistence'
import {
  getStartupErrorFallbackUI,
  hydratePersistedUIAfterStartupRead
} from './lib/startup-ui-hydration'
import { shouldRenderPetOverlay } from './components/pet/pet-overlay-visibility'
import { applyDocumentTheme } from './lib/document-theme'
import { getSystemPrefersDark } from './lib/terminal-theme'
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
  ModifierDoubleTapDetector,
  toModifierDoubleTapEvent
} from '../../shared/modifier-double-tap-detector'
import { isGitRepoKind } from '../../shared/repo-kind'
import { showTerminalShortcutCaptureNotification } from '@/lib/terminal-shortcut-capture-notification'
import { resolveMountedLazyModalIds, type LazyModalId } from './lazy-modal-mount-state'
import { translate } from '@/i18n/i18n'
import PinnedTabCloseDialog from './components/terminal-pane/PinnedTabCloseDialog'

const isMac = navigator.userAgent.includes('Mac')
const isWindows = !isMac && navigator.userAgent.includes('Windows')
const shortcutPlatform: NodeJS.Platform = isMac ? 'darwin' : isWindows ? 'win32' : 'linux'

function getKeybindingContext(target: EventTarget | null): KeybindingContext {
  return target instanceof HTMLElement && target.classList.contains('xterm-helper-textarea')
    ? 'terminal'
    : 'app'
}

// Abstraction over a real KeyboardEvent and a synthetic double-tap gesture so a
// single dispatch path serves both. KeybindingInput-compatible (key/code +
// modifier flags) so it flows straight into keybindingMatchesAction.
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

// Why: 'hidden' titleBarStyle on Windows removes the native OS title bar,
// so we render our own minimize/maximize/close buttons.  These SVG icons match
// the Fluent/Win11 style: thin 10×10 paths on a 40×30 hit area.
function WindowControls(): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    // Why: window:maximize-changed only fires on transitions, so a window
    // restored to a maximized state at startup would render the wrong icon
    // until the user first clicks the button. Seed from main on mount.
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
        // Why: IPC to main so the BrowserWindow 'close' event fires, which
        // sends 'window:close-requested' back to the renderer and keeps the
        // terminal-running confirmation guard active. window.close() is
        // unreliable in sandboxed renderers.
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
// Why: lazy-loaded so the WebP asset + overlay module aren't fetched unless
// the user opts into the experimental flag.
const PetOverlay = lazy(() => import('./components/pet/PetOverlay'))
// Why: lazy so onboarding's step modules + assets aren't fetched for users
// past first-launch. The gate `shouldShowOnboarding` lives in its own tiny
// module so no eager import path pulls OnboardingFlow into the main chunk.
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

  // Why: Zustand actions are referentially stable, but each individual
  // useAppStore(s => s.someAction) still registers a subscription that React
  // must check on every store mutation. Consolidating action refs into one
  // useShallow subscription means one equality check instead of many.
  const actions = useAppStore(
    useShallow((s) => ({
      toggleSidebar: s.toggleSidebar,
      fetchRepos: s.fetchRepos,
      fetchProjectGroups: s.fetchProjectGroups,
      fetchFolderWorkspaces: s.fetchFolderWorkspaces,
      fetchAllWorktrees: s.fetchAllWorktrees,
      fetchWorktreeLineage: s.fetchWorktreeLineage,
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
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activePendingCreationId = useAppStore((s) => s.activePendingCreationId)
  // Why: the creation surface owns the tab strip from the first pending frame.
  // Gating it on the delayed loader flag made the tab bar swap in mid-create.
  const activePendingCreationExists = useAppStore(
    (s) =>
      s.activePendingCreationId !== null &&
      s.pendingWorktreeCreations[s.activePendingCreationId] !== undefined
  )
  // Why: App swaps the sidebar between workspace and landing layouts when the
  // active workspace is slept/deleted. Keep virtualized scroll memory above
  // that remount so the left workspace list doesn't restart at scrollTop 0.
  const worktreeSidebarScrollOffsetRef = useRef(0)
  const worktreeSidebarScrollAnchorRef = useRef<VirtualizedScrollAnchor>(null)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const floatingVisibleTabCount = useAppStore(selectFloatingVisibleTabCount)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const expandedPaneByTabId = useAppStore((s) => s.expandedPaneByTabId)
  const canExpandPaneByTabId = useAppStore((s) => s.canExpandPaneByTabId)
  const workspaceSessionReady = useAppStore((s) => s.workspaceSessionReady)
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
  if (activeWorktreeId !== null) {
    hasMountedTerminalWorkbenchRef.current = true
  }
  // Why: skip the terminal bundle on the no-workspace landing path, but once a
  // workspace has mounted, keep Terminal-owned hidden panes alive through sleep
  // and shutdown transitions where activeWorktreeId can briefly become null.
  const shouldMountTerminalWorkbench =
    activeWorktreeId !== null || hasMountedTerminalWorkbenchRef.current
  // Why: visible worktree creation owns its faux tab strip from start to finish;
  // the previous workspace must stay mounted for retention without rendering
  // real chrome.
  const creationLayoutActive = shouldShowWorktreeCreationSurface({
    activeView,
    activePendingCreationId,
    hasActivePendingCreation: activePendingCreationExists
  })
  const workspaceChromeActive =
    activeView === 'terminal' && activeWorktreeId !== null && !creationLayoutActive
  const terminalWorkbenchVisible =
    activeView === 'terminal' && activeWorktreeId !== null && !creationLayoutActive
  // Why: a closed empty floating workspace is not startup-critical. Once it owns
  // tabs, keep it mounted while closed so hidden terminal/browser/editor panes
  // retain their local state.
  const shouldMountFloatingTerminalPanel =
    floatingTerminalEnabled && (floatingTerminalOpen || floatingVisibleTabCount > 0)
  // Why: the floating workspace is a transient overlay; hotkey minimize should
  // return keyboard focus to the surface the user was working in before it.
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
      // Why: recordFeatureInteraction updates Zustand subscribers; doing it
      // inside React's state updater logs a render-phase update warning.
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
    // Why: the settings detour is valid only while Settings is onscreen; clear
    // it during render so onboarding can resume without a follow-up Effect pass.
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
      // Why: AddRepoDialog's close effect aborts in-flight clone/nested work.
      // Keep one closed render, then remove hidden SSH/remote subscriptions.
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
  // Why: retention must run at App level so the inline per-card agents list
  // always sees retained entries. If retention ran inside the sidebar-card
  // subtree, "done" agents would vanish any time the user collapsed a card's
  // inline agents section. The retention hooks are hosted inside
  // <RetainedAgentsSyncGate /> (a leaf component that renders null) rather
  // than being called inline here so its high-churn store subscriptions
  // (agentStatusByPaneKey ticks at PTY event frequency)
  // do not re-render the App tree on every agent status update.
  // Why: git conflict-operation state also drives the worktree cards. Polling
  // cannot live under RightSidebar because App unmounts that subtree when the
  // sidebar is closed, which leaves stale "Rebasing"/"Merging" badges behind
  // until some unrelated view remount happens to refresh them.
  // Why: visible-window polling runs immediately on mount. Wait until the
  // workspace session has hydrated so git status work cannot compete with the
  // first window becoming usable.
  useGitStatusPolling({ enabled: workspaceSessionReady })
  // Why: the editor must hear external filesystem changes regardless of
  // which right-sidebar panel is visible (Explorer unmounts when the user
  // switches to Source Control or Checks). Wiring this at App level mirrors
  // VSCode's workbench-scoped `TextFileEditorModelManager`, which reloads
  // clean models from a single always-on file-change subscription instead
  // of tying reloads to the Explorer UI lifecycle.
  useEditorExternalWatch()
  useGlobalFileDrop()
  useAutoAckViewedAgent()

  useEffect(() => {
    return onOnboardingReopened(setOnboarding)
  }, [])

  useEffect(() => {
    // Why: `onboarding === null` is the startup loading state. Suppress
    // contextual tours until the persisted onboarding state is known so a
    // first-run user cannot have a tour marked seen before onboarding appears.
    const suppressTours = !onboardingLoaded || shouldShowOnboarding(onboarding)
    actions.setContextualToursOnboardingVisible(suppressTours)
  }, [actions, onboarding, onboardingLoaded])

  useEffect(() => {
    if (!persistedUIReady || !onboardingLoaded || contextualToursAutoEligible !== null) {
      return
    }
    // Why: this rollout is for users who are still in first-run onboarding.
    // Existing profiles are locally classified once and never auto-toured.
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
      // Why: first-download users should finish onboarding without a second
      // education modal appearing later in the same first-run session.
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
    // Why: once a tip is visible, app quit/crash should not make it reappear
    // on the next launch just because the user never clicked a dismiss button.
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

  // Why: sidebar open/close flips width instantaneously. useLayoutEffect
  // runs synchronously after React commits the DOM but before paint, so
  // dispatching SYNC_FIT_PANES_EVENT here lets the terminal reflow in the
  // same frame as the width change — no "wrongly-sized terminal" transient
  // and no delayed snap. The later ResizeObserver rAF and 150ms debounced
  // fit both become no-ops because proposeDimensions() will match the
  // already-fitted cols/rows.
  useLayoutEffect(() => {
    window.dispatchEvent(new CustomEvent(SYNC_FIT_PANES_EVENT))
  }, [sidebarOpen, rightSidebarOpen])

  // Fetch initial data + hydrate GitHub cache from disk
  useEffect(() => {
    let cancelled = false
    // Why: AbortController must be declared outside the async block so the
    // cleanup function can abort it. Under StrictMode the effect runs twice;
    // without this, the first (unmounted) pass would keep spawning PTYs.
    const abortController = new AbortController()

    // Why (issue #1158): hydrate persisted UI immediately after ui.get()
    // succeeds, before any later session step can throw. The UI writer is
    // gated only on persistedUIReady, so falling back to defaults after a
    // successful ui.get() would serialize those defaults back to disk.
    let uiHydrated = false
    // Why (issue #1158): track whether the success-path call to
    // reconnectPersistedTerminals started so the catch path doesn't run it a
    // second time. Reconnect mutates store state via per-tab set() blocks
    // inside its loops (populating tabsByWorktree / ptyIdsByTabId); re-entering
    // it on partially-mutated state would double-set ptyIds and drain pending*
    // maps twice. If the success-path call started and threw mid-loop, those
    // per-tab set() blocks may have populated tabsByWorktree / ptyIdsByTabId
    // for some tabs but did NOT reach the tail set() that flips
    // workspaceSessionReady — so we still need to force the flag true so the
    // UI mounts.
    let reconnectStarted = false
    void (async () => {
      try {
        // Why: repo/worktree hydration routes through settings.activeRuntimeEnvironmentId.
        // Load settings first so a persisted remote runtime does not boot against
        // the local filesystem and then hydrate stale local workspace state.
        await actions.fetchSettings()
        await actions.fetchRepos()
        await actions.fetchProjectGroups()
        await actions.fetchFolderWorkspaces()
        await actions.fetchAllWorktrees()
        await actions.fetchWorktreeLineage()
        const persistedUI = await window.api.ui.get()
        uiHydrated = hydratePersistedUIAfterStartupRead({
          persistedUI,
          cancelled,
          hydratePersistedUI: actions.hydratePersistedUI
        })
        // Why: runtime-owned worktree slices live in per-host partitions.
        // Repos were fetched above, so the known runtime hosts are derivable
        // here; merge their slices into the unified session the hydrators
        // expect. An unreadable host partition is skipped (fail-soft).
        const session = await fetchWorkspaceSessionFromHosts(
          window.api.session,
          useAppStore.getState().repos
        )
        await actions.fetchKeybindings()
        if (!cancelled) {
          actions.hydrateWorkspaceSession(session)
          actions.hydrateTabsSession(session)
          actions.hydrateEditorSession(session)
          actions.hydrateBrowserSession(session)
          // Why: prune lastVisitedAtByWorktreeId entries whose worktrees
          // no longer exist. Must run AFTER hydration — before this point,
          // async repo loads may not have populated worktreesByRepo yet and
          // pruning would delete timestamps for worktrees that are about to
          // appear. Seed the restored active worktree's timestamp if missing
          // so users upgrading from a pre-feature build don't see the active
          // worktree sink in the empty-query list.
          // See docs/cmd-j-empty-query-ordering.md.
          actions.pruneLastVisitedTimestamps()
          actions.seedActiveWorktreeLastVisitedIfMissing()
          await actions.fetchBrowserSessionProfiles()
          const onboardingState = await window.api.onboarding.get()
          if (!cancelled) {
            setOnboarding(onboardingState)
            setOnboardingLoaded(true)
          }

          // Why: SSH connections must be re-established BEFORE terminal
          // reconnect so that reconnectPersistedTerminals can route SSH-backed
          // tabs through pty.attach on the relay. Passphrase-protected targets
          // are deferred to tab focus to avoid stacking credential dialogs at
          // startup before the user has context.
          const connectionIds = session.activeConnectionIdsAtShutdown ?? []
          if (connectionIds.length > 0) {
            try {
              const SSH_RECONNECT_TIMEOUT_MS = 15_000
              const allTargets = await window.api.ssh.listTargets()
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

              // Why: track which eager targets timed out so we can treat them
              // as deferred — the underlying ssh.connect() keeps running in the
              // main process, but reconnectPersistedTerminals won't see them as
              // connected. Adding them to the deferred list ensures PTYs get
              // reattached when the user focuses the tab (by which time the
              // slow connect will likely have succeeded).
              const timedOutTargets: string[] = []
              await Promise.allSettled(
                eagerTargets.map(({ targetId }) =>
                  Promise.race([
                    window.api.ssh.connect({ targetId }),
                    new Promise((_, reject) =>
                      setTimeout(
                        () => reject(new Error('SSH reconnect timeout')),
                        SSH_RECONNECT_TIMEOUT_MS
                      )
                    )
                  ]).catch((err) => {
                    const isTimeout =
                      err instanceof Error && err.message === 'SSH reconnect timeout'
                    if (isTimeout) {
                      timedOutTargets.push(targetId)
                    }
                    console.warn(`SSH auto-reconnect failed for ${targetId}:`, err)
                  })
                )
              )
              if (timedOutTargets.length > 0) {
                actions.setDeferredSshReconnectTargets([
                  ...deferredTargets.map((t) => t.targetId),
                  ...timedOutTargets
                ])
              }

              // Why: ssh.connect() resolves before the ssh:state-changed IPC
              // event updates sshConnectionStates in the store. Without this,
              // reconnectPersistedTerminals reads stale state and misclassifies
              // successfully connected targets as disconnected, stranding their
              // persisted PTYs. Polling getState ensures the store is current.
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
          }

          // Why: main overlaps daemon/hook startup with renderer hydration for
          // first paint, but restored terminals still need those services ready
          // before they mount and spawn/reconnect PTYs.
          await window.api.app.awaitFirstWindowStartupServices()
          reconnectStarted = true
          await actions.reconnectPersistedTerminals(abortController.signal)
          syncZoomCSSVar()
          // Why (issue #1158): unlock the debounced session writer only after
          // hydration AND all dependent startup steps (SSH reconnect, terminal
          // reconnect) completed without throwing. If this flag flipped earlier
          // and a later step threw, the catch path's reconnectPersistedTerminals
          // would flip workspaceSessionReady=true with the gate already open,
          // and the writer would serialize a partially-mutated store back to
          // disk — the exact data-loss mode this PR fixes.
          actions.setHydrationSucceeded(true)
        }
      } catch (error) {
        // Why (issue #1158): previously this catch called hydrateWorkspaceSession
        // with empty defaults, which overwrote the in-memory tab map. The
        // debounced session writer then serialized that empty state back to
        // orca-data.json, silently erasing the user's saved tabs. The fix is
        // to leave in-memory state untouched and keep hydrationSucceeded
        // false so the writer stays gated. We still ensure persistedUIReady and
        // workspaceSessionReady flip so the UI can mount without a session.
        const stepLabel = error instanceof Error && error.message ? error.message : String(error)
        console.error(
          '[startup] Workspace session hydration failed; leaving disk state untouched:',
          stepLabel,
          error
        )
        if (!cancelled) {
          // Why (issue #1158): only hydrate UI with defaults if ui.get() never
          // produced persisted data. If the real UI hydrate already ran and a
          // later session step threw, defaults would flow through the debounced
          // UI writer and clobber ui.json (sidebar width, sort, filters, etc.).
          const fallbackUI = getStartupErrorFallbackUI(uiHydrated)
          if (fallbackUI) {
            actions.hydratePersistedUI(fallbackUI)
          }
          // Why (issue #1158): surface a sticky, dismissible toast so the
          // user knows they're in degraded "no-save" mode. Without this, every
          // new tab/file/browse becomes silently ephemeral — `hydrationSucceeded`
          // stays false for the rest of the process and the session writer is
          // a no-op. The "Restart now" action calls app.relaunch (defined in
          // src/main/ipc/app.ts) so the user can recover with one click instead
          // of having to find a quit/relaunch path themselves.
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
          // Why: reconnectPersistedTerminals flips workspaceSessionReady so the
          // UI mounts; auto-tab-creation becomes unblocked. hydrationSucceeded
          // is intentionally NOT set — the session writer must stay a no-op
          // until the user gets a clean restart, so we don't overwrite the
          // on-disk file we failed to load.
          if (!reconnectStarted) {
            try {
              await window.api.app.awaitFirstWindowStartupServices()
              await actions.reconnectPersistedTerminals(abortController.signal)
            } catch (reconnectErr) {
              console.error(
                '[startup] reconnectPersistedTerminals failed in error path:',
                reconnectErr
              )
              // Why (issue #1158): re-check !cancelled before mutating store
              // state. The await above may have run while the effect was being
              // torn down (StrictMode pass 1 cleanup) — in that case the
              // second pass owns hydration and we must not stomp its work
              // from a cancelled run.
              if (!cancelled) {
                // Why (issue #1158): this is already the recovery path from a
                // failed hydration. If the recovery itself throws, the async IIFE
                // rejects as an unhandled promise and workspaceSessionReady never
                // flips — leaving the user staring at a blank window. Forcing the
                // flag true lets the app shell mount with an empty session, which
                // is strictly better than a non-functional UI.
                //
                // Also clear pendingReconnect* maps because reconnectPersistedTerminals
                // normally drains them as part of its post-conditions
                // (see terminals.ts post-loop cleanup). Bypassing that drain by
                // flipping only the flag would leave stale reconnect data in
                // memory — any later reader of pending* maps could trigger
                // phantom reconnect attempts on PTYs that no longer exist.
                useAppStore.setState({
                  workspaceSessionReady: true,
                  pendingReconnectWorktreeIds: [],
                  pendingReconnectTabByWorktree: {},
                  pendingReconnectPtyIdByTabId: {}
                })
              }
            }
          } else {
            // Why (issue #1158): the success-path call to
            // reconnectPersistedTerminals already started; its per-tab set()
            // blocks may have populated tabsByWorktree / ptyIdsByTabId for
            // some tabs but did NOT reach the tail set() that flips
            // workspaceSessionReady (that runs after the loop completes).
            // Don't re-run reconnect over partially-mutated state — doing so
            // would double-set ptyIds and drain pending* maps twice. Force
            // the flag true so the UI mounts. The same pending* clear applies
            // here for the same reason as above.
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
      const systemPrefersDark = getSystemPrefersDark()
      // Why: skip the key build entirely when every input field is unchanged
      // by reference. Mirrors every field used by
      // getRuntimeMobileSessionSyncKey so this gate covers every "could the
      // key have changed?" case.
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

  // Why: session persistence never drives JSX — it only writes to disk.
  // Using a Zustand subscribe() outside React removes ~15 subscriptions from
  // App's render cycle, eliminating re-renders on every tab/file/browser change.
  useEffect(() => {
    return createSessionWriteSubscriber({
      store: useAppStore,
      shouldSchedulePersist: () => !isRemoteWorkspaceSnapshotApplyInProgress(),
      persist: ({ patch }) => {
        const state = useAppStore.getState()
        // Why: route each runtime host's worktree-scoped slice to its own
        // partition; the returned promise is the local write so the
        // remote-workspace upload chain below keeps its ordering.
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

  // On shutdown, capture terminal scrollback buffers and flush to disk.
  // Runs synchronously in beforeunload: capture → Zustand set → sendSync → flush.
  useEffect(() => {
    // Why: beforeunload fires twice during a manual quit — once from the
    // synthetic dispatch in the onWindowCloseRequested handler (captures
    // good data while TerminalPanes are still mounted), and again from the
    // native window close triggered by confirmWindowClose(). Between these
    // two firings, PTY exit events can arrive and unmount TerminalPanes,
    // emptying shutdownBufferCaptures. The guard prevents the second call
    // from overwriting the good session data with an empty snapshot.
    let shutdownBuffersCaptured = false
    const captureAndFlush = (): void => {
      if (shutdownBuffersCaptured) {
        return
      }
      if (!shouldPersistWorkspaceSession(useAppStore.getState())) {
        return
      }
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
      useAppStore.getState().captureAllSleepingAgentSessions()
      // Why: re-read state after capture() calls populated scrollback buffers
      // into the store via Zustand setters. The earlier read is only for the
      // gating flags and would miss those updates.
      const freshState = useAppStore.getState()
      persistWorkspaceSessionByHostSync(
        window.api.session,
        buildWorkspaceSessionPayload(freshState),
        freshState
      )
      shutdownBuffersCaptured = true
    }
    window.addEventListener('beforeunload', captureAndFlush)
    return () => window.removeEventListener('beforeunload', captureAndFlush)
  }, [])

  // Own the single window-close-request subscription at the always-mounted App
  // root. Why: the rich confirmation flow lives in Terminal, which is not
  // mounted on the no-workspace landing page (and is lazy-loaded elsewhere), so
  // subscribing there left File → Exit / Ctrl+Q with no listener and the window
  // never closed (#5144). dispatchWindowCloseRequest delegates to Terminal's
  // handler when present, else confirms the close directly.
  useEffect(() => {
    return window.api.ui.onWindowCloseRequested(dispatchWindowCloseRequest)
  }, [])

  // Why there is no periodic scrollback save: PR #461 added a 3-minute
  // setInterval that re-serialized every mounted TerminalPane's scrollback
  // so a crash wouldn't lose in-session output. With many panes of
  // accumulated output, each tick blocked the renderer main thread for
  // several seconds (serialize is synchronous and does a binary search on
  // >512KB buffers), causing visible input lag across the whole app.
  // The durable replacement is the out-of-process terminal daemon
  // (PR #729), which preserves buffers across renderer crashes with no
  // main-thread work. Non-daemon users lose in-session scrollback on an
  // unexpected exit — an acceptable tradeoff vs. periodic UI stalls, and
  // in line with how most terminal apps behave.

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
        // Why: system theme changes do not mutate the store, so mobile
        // terminal colors need an explicit graph republish.
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

  const tabs = activeWorktreeId ? (tabsByWorktree[activeWorktreeId] ?? []) : []
  const hasTabBar = tabs.length >= 2
  const effectiveActiveTabId = activeTabId ?? tabs[0]?.id ?? null
  const activeTabCanExpand = effectiveActiveTabId
    ? (canExpandPaneByTabId[effectiveActiveTabId] ?? false)
    : false
  const effectiveActiveTabExpanded = effectiveActiveTabId
    ? (expandedPaneByTabId[effectiveActiveTabId] ?? false)
    : false
  const showTitlebarExpandButton = workspaceChromeActive && !hasTabBar && effectiveActiveTabExpanded
  // Why: Activity and Space are full-page navigation surfaces — same
  // treatment as Settings — so the worktree sidebar is removed for those views.
  const showSidebar =
    activeView !== 'settings' &&
    activeView !== 'activity' &&
    activeView !== 'space' &&
    activeView !== 'skills'
  // Why: Tasks/Landing keep the full titlebar only when the sidebar is
  // collapsed; with it open, mirror workspace view so titlebar-left sits flush
  // above nav. Creation layout suppresses the full-width titlebar.
  const stackedSidebarOpen =
    !workspaceChromeActive && !creationLayoutActive && showSidebar && sidebarOpen
  // Why: visible creation keeps only the top-left window chrome; workspace tabs
  // and right-sidebar chrome remain gated by workspaceChromeActive.
  const leftTitlebarChromeLayout = resolveLeftTitlebarChromeLayout({
    workspaceChromeActive,
    stackedSidebarOpen,
    creationLayoutActive,
    sidebarOpen
  })
  // Why: suppress right sidebar controls on full-page navigation surfaces
  // since those surfaces intentionally own the full content area.
  const showRightSidebarControls = !creationLayoutActive && canShowRightSidebarForView(activeView)

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

  useEffect(() => {
    const doubleTapDetector = new ModifierDoubleTapDetector()

    const dispatchShortcutInput = (input: ShortcutDispatchInput): void => {
      // Why: child-component handlers (e.g. terminal search Cmd+G / Cmd+Shift+G)
      // register on the same window capture phase and fire first. If they already
      // called preventDefault, this handler must not also act on the event —
      // otherwise both actions execute (e.g. search navigation AND sidebar open).
      if (input.defaultPrevented) {
        return
      }
      // Why: the Settings recorder intentionally captures existing app
      // shortcuts, so global handlers must not fire while its button has focus.
      if (
        input.target instanceof Element &&
        input.target.closest('[data-shortcut-recorder-active]') !== null
      ) {
        return
      }
      const context = getKeybindingContext(input.target)

      // Note: some app-level shortcuts are also intercepted via
      // before-input-event in createMainWindow.ts so they still work when a
      // browser guest has focus. The renderer keeps matching handlers for
      // local-focus cases and to preserve the same guards in one place.

      const matchShortcut = (actionId: KeybindingActionId): boolean =>
        keybindingMatchesAction(actionId, input, shortcutPlatform, keybindings, {
          context,
          terminalShortcutPolicy: settings?.terminalShortcutPolicy
        })
      const notifyTerminalCapture = (actionId: KeybindingActionId): void => {
        if (
          context !== 'terminal' ||
          (settings?.terminalShortcutPolicy ?? 'orca-first') !== 'orca-first'
        ) {
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
        // Why: when focus is inside the file explorer and a folder is selected,
        // Cmd/Ctrl+Shift+F means "Find in Folder" — seed the include pattern
        // with that folder instead of treating the chord as a text-search seed.
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

      // Why: an empty floating workspace has no tab to close; Cmd/Ctrl+W
      // should hide that transient overlay before underlying app surfaces act.
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

      // Why: keep this guard. TipTap's Cmd+B bold binding depends on the
      // window-level handler *not* toggling the sidebar when focus lives in an
      // editable surface. The main-process before-input-event already carves out
      // Cmd+B for the markdown editor (see createMainWindow.ts +
      // docs/markdown-cmd-b-bold-design.md), but this renderer-side fallback
      // still covers the blur→press IPC race and any non-carved editable surface.
      if (isEditableTarget(input.target)) {
        return
      }

      // Why: xterm's helper textarea is intentionally not a generic editable
      // target, but floating-terminal SSH/tmux control chords must still reach
      // the terminal instead of app-level chrome shortcuts.
      if (isFloatingWorkspaceTerminalInputTarget(input.target)) {
        return
      }

      // Cmd/Ctrl+Alt+Arrow — worktree history back/forward. This stays before
      // right-sidebar shortcuts because it is navigation, not sidebar reveal.
      if (matchShortcut('worktree.history.back') || matchShortcut('worktree.history.forward')) {
        // Why: Back/Forward traverse mixed worktree + page visits, so the
        // shortcut is active wherever the titlebar button cluster is (terminal
        // or stack-backed pages). Still suppressed in Settings.
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

      // Why: only short-circuit chords the floating panel's own keydown
      // handler claims (Cmd/Ctrl+T, Cmd/Ctrl+W, Cmd/Ctrl+Shift+B/M). Other
      // app-level mod shortcuts (B, L, Shift+E/F/G) have no panel-level
      // counterpart, so suppressing them here would silently no-op when
      // focus lives inside the floating panel.
      const floatingWorkspaceFocused = isFloatingWorkspacePanelFocused()
      if (floatingWorkspaceFocused) {
        if (
          isFloatingWorkspacePanelShortcut(input, shortcutPlatform, null, keybindings, {
            context,
            terminalShortcutPolicy: settings?.terminalShortcutPolicy
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

      // Why: rename the active terminal tab. Cmd+R is free in the app/terminal
      // focus zone because the browser pane owns its own Cmd+R reload and that
      // focus never reaches this renderer-window handler. Only terminal tabs
      // have an inline title editor, so other active tab types fall through.
      if (workspaceChromeActive && !floatingWorkspaceFocused && matchShortcut('tab.rename')) {
        const store = useAppStore.getState()
        if (store.activeTabType === 'terminal' && store.activeTabId) {
          input.preventDefault()
          notifyTerminalCapture('tab.rename')
          store.setRenamingTabId(store.activeTabId)
          return
        }
      }

      // Why: open the active worktree's inline title editor. Open/reveal it
      // first so the card is mounted and visible even when sidebar filters or
      // collapse state would otherwise hide it.
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

      // Why: Cmd/Ctrl+N is handled via the main-process before-input-event
      // allowlist (see window-shortcut-policy.ts / useIpcEvents.ts) so it works
      // globally — including when focus lives inside the markdown rich editor
      // (contentEditable) or a browser guest webContents, both of which bypass
      // this renderer-side window keydown listener.

      // Why: full-page navigation surfaces should not reveal the right sidebar;
      // they are designed as distraction-free content areas.
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

      // Cmd/Ctrl+Shift+G — toggle right sidebar / source control tab.
      // Skip when terminal search is open — Cmd+Shift+G means "find previous"
      // in that context (handled by keyboard-handlers.ts). Both listeners share
      // the window capture phase and registration order can vary with React
      // effect re-runs, so a DOM check is the reliable coordination mechanism.
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

      if (matchShortcut('sidebar.checks.toggle')) {
        input.preventDefault()
        notifyTerminalCapture('sidebar.checks.toggle')
        actions.setRightSidebarTab('checks')
        actions.setRightSidebarOpen(true)
        return
      }

      // Cmd+Shift+I — toggle right sidebar / ports tab (macOS only).
      // Why: Ctrl+Shift+I is the built-in DevTools accelerator on Windows/Linux;
      // intercepting it would break an essential developer tool.
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
  }, [
    activeView,
    activeWorktreeId,
    actions,
    floatingTerminalOpen,
    floatingVisibleTabCount,
    keybindings,
    settings?.terminalShortcutPolicy,
    setFloatingTerminalOpenWithFocus,
    workspaceChromeActive,
    creationLayoutActive
  ])

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
    // Why: lazy-load these modals only after first use, then keep them mounted
    // so repeat opens preserve their local state and avoid re-fetch flashes.
    setMountedLazyModalIds(new Set(resolvedMountedLazyModalIds))
  }

  // Why: extracted so both the full-width titlebar (settings/landing) and
  // the sidebar-width left header (workspace view) can share the same
  // controls without duplicating the agent badge popover.
  const titlebarLeftControls = (
    // Why: measure the ENTIRE row (traffic-light pad + sidebar toggle + agent
    // badge + back/forward group) so the sidebar-collapse spacer in
    // TabGroupPanel reserves enough width to clear the full floating
    // `titlebar-left`. Measuring only the inner control cluster left the
    // back/forward arrows hanging over the first tab when the sidebar was
    // collapsed (Cmd+B), producing a half-occluded, non-scrollable tab strip.
    // Why: collapsed workspace mode floats inside a w-0 sidebar wrapper; w-max
    // prevents Windows Chromium from shrinking the app name down to one glyph.
    <div
      ref={titlebarLeftControlsRef}
      className={`flex h-full shrink-0 items-center${
        leftTitlebarChromeLayout.isFloating ? ' w-max' : ' w-full'
      }`}
    >
      <div className="flex h-full items-center">
        {isMac && !isFullScreen ? (
          <div className="titlebar-traffic-light-pad" />
        ) : isWindows ? (
          /* Why: on Windows the native title bar is hidden, so we render the
             Orca logo as a non-interactive identity anchor and a ··· button
             that pops up the application menu (the same menu revealed by Alt
             on the default autoHideMenuBar). */
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
        {showSidebar && !isWindows && (
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
      {/* Why: Back/Forward traverse mixed worktree + page history, so the
          cluster is shown wherever the history shortcut is live. Hidden in
          Settings and non-stack page views. */}
      {shouldShowWorktreeHistoryControls(activeView) && (
        // Why: when the workspace sidebar is collapsed, this header shrink-wraps
        // and ml-auto has no spare width; keep a fixed gutter before Back.
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
      {/* Why: when the right sidebar is open, its own header renders
      an identical close button — hide this copy so only one is
      visible at a time. */}
      {!rightSidebarOpen && rightSidebarToggle}
      {/* Why: reserve space so content is not obscured by the
      fixed-position window-controls overlay on Windows. */}
      {isWindows && <div className="window-controls-titlebar-spacer" />}
    </>
  )

  return (
    <div
      ref={setAppRootNode}
      className="flex flex-col h-dvh w-screen overflow-hidden"
      style={
        {
          '--collapsed-sidebar-header-width': `${collapsedSidebarHeaderWidth}px`,
          // Why: consumed by anything that needs to avoid the fixed-position
          // window-controls overlay on Windows (floating sidebar toggle, right
          // sidebar header, etc.) without hardcoding 138px in multiple places.
          '--window-controls-width': isWindows ? '138px' : '0px',
          // Why: consumed by the side-position activity bar to push icons below
          // the fixed-position window-controls overlay on Windows.
          '--window-controls-height': isWindows ? '36px' : '0px'
        } as React.CSSProperties
      }
    >
      <TooltipProvider delayDuration={400}>
        <ConfirmationDialogProvider>
          <LinkRoutingPreferenceDialogProvider>
            <WorkspacePortScanner enabled={workspaceSessionReady} />
            {/* Why: leaf-mounted retention sync keeps agent-status retention
            subscriptions from re-rendering the App tree. */}
            <RetainedAgentsSyncGate />
            <AgentHibernationGate />
            {/* Why: workspace activation is a hot path; including activeWorktreeId
            in reset keys remounts whole surfaces during wake. */}
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
                {/* Why: the non-workspace titlebar lives inside this left+center
              wrapper so it does not span over the right-sidebar column —
              when the right sidebar is open, its own header anchors at the
              top alongside the titlebar instead of being pushed below it. */}
                <div className="flex flex-col flex-1 min-w-0 min-h-0">
                  {/* Why: in workspace view (split groups always enabled), the
                full-width titlebar is removed so tab groups + terminal extend
                to the top of the window. Left titlebar controls move to a
                header above the sidebar. Settings, landing, and the tasks
                page keep the titlebar. */}
                  {!leftTitlebarChromeLayout.shouldMount ? (
                    <div className="titlebar">
                      <div className="flex items-center shrink-0 mr-2">{titlebarLeftControls}</div>
                      {titlebarMainStrip}
                    </div>
                  ) : null}
                  <div className="flex flex-row flex-1 min-h-0 overflow-hidden">
                    {showSidebar ? (
                      leftTitlebarChromeLayout.shouldMount ? (
                        /* Why: left column wraps the sidebar with a titlebar-height
                     header above it. The header holds the same controls
                     (traffic lights, sidebar toggle, "Orca" title, agent badge)
                     that the full-width titlebar held while the center and right
                     columns keep their own top strips at the same 36px height.
                     When the sidebar is collapsed, take this header out of flex
                     layout so the terminal/editor reclaim the left edge instead of
                     leaving behind a content-width blank strip. */
                        <div
                          className={`flex min-h-0 flex-col shrink-0${sidebarOpen ? '' : ' relative w-0 overflow-visible'}`}
                        >
                          <div
                            // Why: when the sidebar is collapsed, titlebar-left floats
                            // absolutely on top of the center column's own `border-l`
                            // (see TabGroupSplitLayout), occluding that seam. Add a
                            // `border-r` in the floating state so the vertical line
                            // between the traffic-light/nav cluster and the tab strip
                            // stays visible in both states. w-max keeps the floating
                            // header sized to its own controls instead of the w-0
                            // sidebar wrapper.
                            className={`titlebar-left${
                              leftTitlebarChromeLayout.isFloating
                                ? ' titlebar-left-floating absolute top-0 left-0 z-10 w-max border-r border-border'
                                : ''
                            }`}
                            style={{
                              // Why: custom sidebar appearances are scoped to the sidebar
                              // root, so mirror those variables onto the open header that
                              // visually belongs to the same left-column panel.
                              ...(sidebarOpen ? leftSidebarStyle : undefined),
                              // Why: the Sidebar resize hook updates the sidebar DOM width
                              // directly during drag and only persists to Zustand on
                              // mouseup. In workspace view, size this header from the
                              // wrapper's live width so it tracks those in-flight resizes
                              // instead of leaving a stale-width gap until the drag ends.
                              width: sidebarOpen ? '100%' : undefined
                            }}
                          >
                            {titlebarLeftControls}
                          </div>
                          <div className="flex min-h-0 flex-1">
                            {/* Why: the workspace-view wrapper adds a fixed 36px header
                          above the sidebar. Without a flex-1/min-h-0 slot here,
                          the sidebar falls back to its content height, so the
                          worktree list loses its scroll viewport and the fixed
                          bottom toolbar (including Add Project) gets pushed offscreen. */}
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
                        {/* Why: right sidebar toggle floats at the top-right of the center
                    column so it's always accessible whether the right sidebar is
                    open or closed. Match the RightSidebar header's 36px height and
                    top-0 anchor so the icon's vertical center is identical between
                    open and closed states — otherwise toggling makes the icon jump
                    a few pixels, which reads as layout jitter. */}
                        {workspaceChromeActive && !rightSidebarOpen && (
                          <div
                            className="absolute top-0 z-10 flex items-center h-[36px]"
                            style={
                              {
                                // Why: right: var(--window-controls-width) is the single
                                // mechanism that keeps the toggle clear of the
                                // fixed-position window-controls overlay on Windows (138px)
                                // and sits at the right edge on non-Windows (0px). No
                                // internal spacer needed — adding one would push the button
                                // a further 138px to the left and cover the pane-actions
                                // Ellipsis button with an un-clickable div.
                                right: 'var(--window-controls-width)',
                                WebkitAppRegion: 'no-drag'
                              } as React.CSSProperties
                            }
                          >
                            {rightSidebarToggle}
                          </div>
                        )}
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
                {/* Why: keep the right-sidebar shell mounted for layout stability.
              Its heavy panels disconnect while closed so workspace wake stays
              responsive. Unmount on the tasks view since that surface is
              intentionally distraction-free. */}
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
            {/* Why: workspace creation is a core action; keeping it in the
            entry bundle avoids stale/corrupt lazy chunks stranding users at Create. */}
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
              {/* Why: Settings can start Add Project without mounting Sidebar,
              so Add Project handoff dialogs must share the root host. */}
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
            {/* Why: root overlays can render Radix <Tooltip>s; keep them inside
            the shared provider so lazy surfaces mount safely from any entry point. */}
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
            {/* Why: mount PetOverlay only after persisted UI hydration, with
          both independent pet toggles allowing it; otherwise a hidden pet
          flashes while the store still has default visibility. */}
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
            {/* Why: the existing-user opt-in banner mounts at App root so it
          renders once per renderer session, not per view. It gates
          internally on the cohort markers populated by the migration,
          so it only shows for users who installed before the telemetry
          release and have not yet resolved consent. New users get no
          first-launch surface — see telemetry-plan.md §First-launch
          experience. */}
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
          </LinkRoutingPreferenceDialogProvider>
        </ConfirmationDialogProvider>
      </TooltipProvider>
      <Toaster closeButton toastOptions={{ className: 'font-sans text-sm' }} />
      <PinnedTabCloseDialog />
      {/* Why: rendered last so it sits after all -webkit-app-region:drag elements
          in DOM order. Electron's hit-test for drag regions is DOM-order-based and
          ignores z-index — placing WindowControls earlier caused the drag region to
          win, making the buttons unclickable. */}
      {isWindows && <WindowControls />}
    </div>
  )
}

export default App
