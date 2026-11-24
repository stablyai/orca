import {
  resolveSidebarSlotChrome,
  resolveSidebarSlotLayout,
  type WindowEdge
} from '@/lib/sidebar-slot-layout'
import { shortcutPlatform } from './app-window-chrome'
import { isPairedWebClientWindow } from './desktop-window-chrome'
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { SYNC_FIT_PANES_EVENT } from '@/constants/terminal'
import { canShowRightSidebarForView } from '@/components/right-sidebar/visibility/right-sidebar-visibility'
import { resolveLeftSidebarStyleVariables } from '@/app-shell/appearance/left-sidebar-appearance'
import { resolveLeftTitlebarChromeLayout } from '@/app-shell/chrome/titlebar-left-chrome'
import { selectWorktreeCreationSurfaceShown } from '@/lib/workspace/creation/worktree-creation-surface'
import { useAppStore } from '../../store/index'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/workspace/identity/floating-workspace-id'
import { selectActiveTerminalChromeState } from './active-terminal-chrome-selector'
import {
  APP_RAIL_WIDTH,
  selectAppRailVisible,
  selectRailPageHidesWorkspaceList
} from '../../components/app-rail/app-rail-layout'
import {
  hasRequestedBackgroundTerminalWorktreeMount,
  subscribeBackgroundTerminalWorktreeMountRequests
} from '../../components/terminal/workspace-mounting/background-terminal-worktree-mount'

export type AppChromeLayout = ReturnType<typeof useAppChromeLayout>

/** Derive titlebar, tab-strip ownership and surface mount decisions from store state. */
export function useAppChromeLayout() {
  const activeView = useAppStore((s) => s.activeView)
  const savedSidebarOpen = useAppStore((s) => s.sidebarOpen)
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  // With the rail on, a rail page fills the width: the list collapses for layout only and the saved state is kept.
  const listHiddenByRailPage = useAppStore(selectRailPageHidesWorkspaceList)
  const sidebarOpen = savedSidebarOpen && !listHiddenByRailPage
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab)
  const rightSidebarExplorerView = useAppStore((s) => s.rightSidebarExplorerView)
  const isFullScreen = useAppStore((s) => s.isFullScreen)
  const settings = useAppStore((s) => s.settings)
  const appRailVisible = useAppStore(selectAppRailVisible)
  const activePendingCreationId = useAppStore((s) => s.activePendingCreationId)
  // Booleans only: App owns this hook, and raw active ids would re-render the whole app on every workspace switch.
  const { hasActiveWorktree, hasTabBar, activeTabCanExpand, effectiveActiveTabExpanded } =
    useAppStore(
      useShallow((s) => {
        const chrome = selectActiveTerminalChromeState(s)
        return {
          hasActiveWorktree: chrome.activeWorktreeId !== null,
          hasTabBar: chrome.tabCount >= 2,
          activeTabCanExpand: chrome.activeTabCanExpand,
          effectiveActiveTabExpanded: chrome.effectiveActiveTabExpanded
        }
      })
    )
  const backgroundTerminalMountRequested = useSyncExternalStore(
    subscribeBackgroundTerminalWorktreeMountRequests,
    hasRequestedBackgroundTerminalWorktreeMount,
    hasRequestedBackgroundTerminalWorktreeMount
  )

  const leftSidebarStyle = useMemo(() => resolveLeftSidebarStyleVariables(settings), [settings])

  // Floating tabs need workbench unsaved-close/quit protection even without an active workspace.
  const floatingWorkspaceHasTabs = useAppStore(
    (s) => (s.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.length ?? 0) > 0
  )
  const canMountTerminalWorkbenchNow =
    hasActiveWorktree || backgroundTerminalMountRequested || floatingWorkspaceHasTabs
  // Use state so discarded renders cannot leak the mount latch; the OR below covers this render.
  const [hasMountedTerminalWorkbench, setHasMountedTerminalWorkbench] = useState(false)
  if (canMountTerminalWorkbenchNow && !hasMountedTerminalWorkbench) {
    setHasMountedTerminalWorkbench(true)
  }
  // Lazy-mount for tabs, then retain hidden panes through temporary null selection during sleep/shutdown.
  const shouldMountTerminalWorkbench = canMountTerminalWorkbenchNow || hasMountedTerminalWorkbench
  // Creation owns faux chrome throughout; retain the previous workspace without its real chrome.
  const creationLayoutActive = useAppStore(selectWorktreeCreationSurfaceShown)
  const workspaceChromeActive =
    activeView === 'terminal' && hasActiveWorktree && !creationLayoutActive
  // Activity/Space own full pages and hide the workspace sidebar.
  const showSidebar =
    activeView !== 'settings' && activeView !== 'activity' && activeView !== 'space'
  // Tasks/Landing keep sidebar-width chrome when open; creation suppresses stacked chrome.
  const sidebarSlots = resolveSidebarSlotLayout({
    workspaceSidebarPosition: settings?.workspaceSidebarPosition,
    platform: shortcutPlatform,
    isWebClient: isPairedWebClientWindow()
  })
  const workspaceSidebarOnLeft = sidebarSlots.leftOccupant === 'workspace'
  const activitySidebarEdge: WindowEdge = workspaceSidebarOnLeft ? 'right' : 'left'
  const showRightSidebarControls = canShowRightSidebarForView(activeView)
  const activitySidebarOpen = rightSidebarOpen && showRightSidebarControls
  const leftOccupantOpen = workspaceSidebarOnLeft ? sidebarOpen : activitySidebarOpen
  const stackedSidebarOpen =
    !workspaceChromeActive && !creationLayoutActive && showSidebar && leftOccupantOpen
  // Creation retains sidebar chrome; workspaceChromeActive gates the workspace tabs.
  const leftTitlebarChromeLayout = resolveLeftTitlebarChromeLayout({
    workspaceChromeActive,
    stackedSidebarOpen,
    creationLayoutActive,
    sidebarOpen: leftOccupantOpen
  })
  const { leftSlotOpen, trailingSlotOpen, leftColumnHeaderFloating } = resolveSidebarSlotChrome({
    leftOccupant: sidebarSlots.leftOccupant,
    workspaceSidebarOpen: sidebarOpen,
    activitySidebarOpen,
    leftTitlebarChromeMounted: leftTitlebarChromeLayout.shouldMount,
    stackedSidebarOpen
  })

  // Fit terminals before paint in the width-change frame to avoid transient wrong sizes.
  useLayoutEffect(() => {
    window.dispatchEvent(new CustomEvent(SYNC_FIT_PANES_EVENT))
  }, [sidebarOpen, rightSidebarOpen, workspaceSidebarOnLeft])

  const titlebarLeftControlsRef = useRef<HTMLDivElement | null>(null)
  const [collapsedSidebarHeaderWidth, setCollapsedSidebarHeaderWidth] = useState(0)
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

  return {
    activeView,
    activePendingCreationId,
    activeTabCanExpand,
    appRailVisible,
    // Tab strips start right of the rail, so they only reserve the header's overhang past it.
    collapsedSidebarHeaderWidth: appRailVisible
      ? Math.max(0, collapsedSidebarHeaderWidth - APP_RAIL_WIDTH)
      : collapsedSidebarHeaderWidth,
    creationLayoutActive,
    hasActiveWorktree,
    isFullScreen,
    leftSidebarStyle,
    leftTitlebarChromeLayout,
    rightSidebarExplorerView,
    rightSidebarOpen,
    rightSidebarTab,
    shouldMountTerminalWorkbench,
    showSidebar,
    // Keep the pending composer in the same viewport as the workspace it hands off to.
    showRightSidebarControls,
    sidebarSlots,
    workspaceSidebarOnLeft,
    activitySidebarEdge,
    leftSlotOpen,
    trailingSlotOpen,
    leftColumnHeaderFloating,
    showTitlebarAppName: settings?.showTitlebarAppName !== false,
    showTitlebarExpandButton: workspaceChromeActive && !hasTabBar && effectiveActiveTabExpanded,
    // Whether the list shows (the saved state, except collapsed on a rail page).
    sidebarOpen,
    // The user's saved choice and width; rail pages size the titlebar's left segment from them.
    savedSidebarOpen,
    sidebarWidth,
    listHiddenByRailPage,
    stackedSidebarOpen,
    // Retained workbench panes need a separate visibility condition.
    terminalWorkbenchVisible: workspaceChromeActive,
    titlebarLeftControlsRef,
    workspaceChromeActive
  }
}
