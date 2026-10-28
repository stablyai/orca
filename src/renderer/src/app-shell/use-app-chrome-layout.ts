import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { SYNC_FIT_PANES_EVENT } from '@/constants/terminal'
import { canShowRightSidebarForView } from '@/lib/right-sidebar-visibility'
import { resolveLeftSidebarStyleVariables } from '@/lib/left-sidebar-appearance'
import { resolveLeftTitlebarChromeLayout } from '@/lib/titlebar-left-chrome'
import { shouldShowWorktreeCreationSurface } from '@/lib/worktree-creation-surface'
import { useAppStore } from '../store'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { selectActiveTerminalChromeState } from '../store/active-terminal-chrome-selector'
import { useSystemPrefersDark } from '../components/terminal-pane/use-system-prefers-dark'
import { selectShownWorkspaceView } from '@/lib/workspace-view-catalog'
import {
  hasRequestedBackgroundTerminalWorktreeMount,
  subscribeBackgroundTerminalWorktreeMountRequests
} from '../components/terminal/background-terminal-worktree-mount'

export type AppChromeLayout = ReturnType<typeof useAppChromeLayout>

/** Derive titlebar, tab-strip ownership and surface mount decisions from store state. */
export function useAppChromeLayout() {
  const activeView = useAppStore((s) => s.activeView)
  const workspaceView = useAppStore(selectShownWorkspaceView)
  const fillWorkspaceView = useAppStore(
    (state) => state.workspaceViewFillWindow && selectShownWorkspaceView(state) !== null
  )
  const sidebarOpen = useAppStore((s) => s.sidebarOpen) && !fillWorkspaceView
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen) && !fillWorkspaceView
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab)
  const rightSidebarExplorerView = useAppStore((s) => s.rightSidebarExplorerView)
  const isFullScreen = useAppStore((s) => s.isFullScreen)
  const settings = useAppStore((s) => s.settings)
  const activePendingCreationId = useAppStore((s) => s.activePendingCreationId)
  // Pending creation owns the tab strip immediately; a delayed loader gate swaps it mid-create.
  const activePendingCreationExists = useAppStore(
    (s) =>
      s.activePendingCreationId !== null &&
      s.pendingWorktreeCreations[s.activePendingCreationId] !== undefined
  )
  const {
    activeWorktreeId,
    tabCount,
    effectiveActiveTabId,
    activeTabCanExpand,
    effectiveActiveTabExpanded
  } = useAppStore(useShallow(selectActiveTerminalChromeState))
  const backgroundTerminalMountRequested = useSyncExternalStore(
    subscribeBackgroundTerminalWorktreeMountRequests,
    hasRequestedBackgroundTerminalWorktreeMount,
    hasRequestedBackgroundTerminalWorktreeMount
  )

  const systemPrefersDark = useSystemPrefersDark()
  const leftSidebarStyle = useMemo(
    () => resolveLeftSidebarStyleVariables(settings, systemPrefersDark),
    [settings, systemPrefersDark]
  ) as React.CSSProperties | undefined

  // Floating tabs need workbench unsaved-close/quit protection even without an active workspace.
  const floatingWorkspaceHasTabs = useAppStore(
    (s) => (s.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.length ?? 0) > 0
  )
  const canMountTerminalWorkbenchNow =
    activeWorktreeId !== null ||
    backgroundTerminalMountRequested ||
    floatingWorkspaceHasTabs ||
    workspaceView !== null
  // Use state so discarded renders cannot leak the mount latch; the OR below covers this render.
  const [hasMountedTerminalWorkbench, setHasMountedTerminalWorkbench] = useState(false)
  if (canMountTerminalWorkbenchNow && !hasMountedTerminalWorkbench) {
    setHasMountedTerminalWorkbench(true)
  }
  // Lazy-mount for tabs, then retain hidden panes through temporary null selection during sleep/shutdown.
  const shouldMountTerminalWorkbench = canMountTerminalWorkbenchNow || hasMountedTerminalWorkbench
  // Creation owns faux chrome throughout; retain the previous workspace without its real chrome.
  const creationLayoutActive = shouldShowWorktreeCreationSurface({
    activeView,
    activePendingCreationId,
    hasActivePendingCreation: activePendingCreationExists
  })
  const workspaceChromeActive =
    activeView === 'terminal' &&
    (activeWorktreeId !== null || workspaceView !== null) &&
    !creationLayoutActive
  const hasTabBar = tabCount >= 2
  // Activity/Space own full pages and hide the workspace sidebar.
  const showSidebar =
    activeView !== 'settings' &&
    activeView !== 'activity' &&
    activeView !== 'space' &&
    !fillWorkspaceView
  // Tasks/Landing keep sidebar-width chrome when open; creation suppresses stacked chrome.
  const stackedSidebarOpen =
    !workspaceChromeActive && !creationLayoutActive && showSidebar && sidebarOpen
  // Creation retains only top-left chrome; workspaceChromeActive gates tabs/right controls.
  const leftTitlebarChromeLayout = resolveLeftTitlebarChromeLayout({
    workspaceChromeActive,
    stackedSidebarOpen,
    creationLayoutActive,
    sidebarOpen
  })

  // Fit terminals before paint in the width-change frame to avoid transient wrong sizes.
  useLayoutEffect(() => {
    window.dispatchEvent(new CustomEvent(SYNC_FIT_PANES_EVENT))
  }, [sidebarOpen, rightSidebarOpen])

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
    activeWorktreeId,
    activePendingCreationId,
    activeTabCanExpand,
    effectiveActiveTabId,
    collapsedSidebarHeaderWidth,
    creationLayoutActive,
    isFullScreen,
    leftSidebarStyle,
    leftTitlebarChromeLayout,
    rightSidebarExplorerView,
    rightSidebarOpen,
    rightSidebarTab,
    shouldMountTerminalWorkbench,
    showSidebar,
    showRightSidebarControls:
      !creationLayoutActive && !fillWorkspaceView && canShowRightSidebarForView(activeView),
    showTitlebarAppName: settings?.showTitlebarAppName !== false,
    showTitlebarExpandButton: workspaceChromeActive && !hasTabBar && effectiveActiveTabExpanded,
    sidebarOpen,
    stackedSidebarOpen,
    // Retained workbench panes need a separate visibility condition.
    terminalWorkbenchVisible: workspaceChromeActive,
    titlebarLeftControlsRef,
    workspaceChromeActive
  }
}
