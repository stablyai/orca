import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { SYNC_FIT_PANES_EVENT } from '@/constants/terminal'
import { canShowRightSidebarForView } from '@/lib/right-sidebar-visibility'
import { resolveLeftSidebarStyleVariables } from '@/lib/left-sidebar-appearance'
import {
  resolveSidebarSlotChrome,
  resolveSidebarSlotLayout,
  type WindowEdge
} from '@/lib/sidebar-slot-layout'
import { resolveLeftTitlebarChromeLayout } from '@/lib/titlebar-left-chrome'
import { shouldShowWorktreeCreationSurface } from '@/lib/worktree-creation-surface'
import { useAppStore } from '../store'
import { selectActiveTerminalChromeState } from '../store/active-terminal-chrome-selector'
import { useSystemPrefersDark } from '../components/terminal-pane/use-system-prefers-dark'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { normalizeWorkspaceSidebarPosition } from '../../../shared/workspace-sidebar-position'
import { shortcutPlatform } from './app-window-chrome'
import {
  hasRequestedBackgroundTerminalWorktreeMount,
  subscribeBackgroundTerminalWorktreeMountRequests
} from '../components/terminal/background-terminal-worktree-mount'

export type AppChromeLayout = ReturnType<typeof useAppChromeLayout>

/**
 * Derives the App shell's layout decisions — which titlebar variant mounts, whether the
 * workspace owns the tab strip, and which surfaces stay mounted — from store state.
 */
export function useAppChromeLayout() {
  const activeView = useAppStore((s) => s.activeView)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab)
  const rightSidebarExplorerView = useAppStore((s) => s.rightSidebarExplorerView)
  const isFullScreen = useAppStore((s) => s.isFullScreen)
  const settings = useAppStore((s) => s.settings)
  const activePendingCreationId = useAppStore((s) => s.activePendingCreationId)
  // Why: the creation surface owns the tab strip from the first pending frame; gating on the delayed loader flag swapped the tab bar mid-create.
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

  const canMountTerminalWorkbenchNow = activeWorktreeId !== null || backgroundTerminalMountRequested
  // Why a latch in state, not a ref: the write has to be visible to the next render, and a
  // render-phase ref write would also survive a render React discards. Setting state during
  // render is the supported way to derive it, and the `||` below keeps this render correct.
  const [hasMountedTerminalWorkbench, setHasMountedTerminalWorkbench] = useState(false)
  if (canMountTerminalWorkbenchNow && !hasMountedTerminalWorkbench) {
    setHasMountedTerminalWorkbench(true)
  }
  // Why: skip the terminal bundle on the landing path, but once mounted keep hidden panes alive through sleep/shutdown when activeWorktreeId briefly goes null.
  const shouldMountTerminalWorkbench = canMountTerminalWorkbenchNow || hasMountedTerminalWorkbench
  // Why: visible worktree creation owns its faux tab strip start to finish; keep the previous workspace mounted for retention without real chrome.
  const creationLayoutActive = shouldShowWorktreeCreationSurface({
    activeView,
    activePendingCreationId,
    hasActivePendingCreation: activePendingCreationExists
  })
  const workspaceChromeActive =
    activeView === 'terminal' && activeWorktreeId !== null && !creationLayoutActive
  const hasTabBar = tabCount >= 2
  // Activity/Space are full-page navigation surfaces (like Settings), so the worktree sidebar is hidden there.
  const showSidebar =
    activeView !== 'settings' && activeView !== 'activity' && activeView !== 'space'
  const sidebarSlots = resolveSidebarSlotLayout({
    workspaceSidebarPosition: normalizeWorkspaceSidebarPosition(settings?.workspaceSidebarPosition),
    platform: shortcutPlatform,
    isWebClient: isPairedWebClientWindow()
  })
  const activitySidebarEdge: WindowEdge =
    sidebarSlots.leftOccupant === 'activity' ? 'left' : 'right'
  const workspaceSidebarOnLeft = sidebarSlots.leftOccupant === 'workspace'
  // Full-page navigation surfaces and worktree creation own the whole content area, so the activity sidebar renders nothing there.
  const showRightSidebarControls = !creationLayoutActive && canShowRightSidebarForView(activeView)
  // Why: slot occupancy must track the sidebar actually drawn, or an unmounted one still reserves its column.
  const activitySidebarOpen = rightSidebarOpen && showRightSidebarControls
  const leftOccupantOpen = workspaceSidebarOnLeft ? sidebarOpen : activitySidebarOpen
  // Tasks/Landing show the full titlebar only when the left sidebar is collapsed; open, they mirror workspace view (creation suppresses it).
  const stackedSidebarOpen =
    !workspaceChromeActive && !creationLayoutActive && showSidebar && leftOccupantOpen
  // Visible creation keeps only the top-left window chrome; tabs and right-sidebar chrome stay gated by workspaceChromeActive.
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

  // Why: useLayoutEffect fires before paint, so dispatching SYNC_FIT_PANES_EVENT reflows the terminal in the same frame as the width change — no wrongly-sized transient.
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
    leftColumnHeaderFloating,
    leftSlotOpen
  ])

  return {
    activeView,
    activitySidebarEdge,
    activeWorktreeId,
    activePendingCreationId,
    activeTabCanExpand,
    effectiveActiveTabId,
    collapsedSidebarHeaderWidth,
    creationLayoutActive,
    isFullScreen,
    leftColumnHeaderFloating,
    leftSidebarStyle,
    leftSlotOpen,
    leftTitlebarChromeLayout,
    rightSidebarExplorerView,
    rightSidebarOpen,
    rightSidebarTab,
    shouldMountTerminalWorkbench,
    showSidebar,
    showRightSidebarControls,
    showTitlebarAppName: settings?.showTitlebarAppName !== false,
    showTitlebarExpandButton: workspaceChromeActive && !hasTabBar && effectiveActiveTabExpanded,
    sidebarOpen,
    sidebarSlots,
    stackedSidebarOpen,
    // Why: the workbench stays mounted while hidden, so visibility tracks the same condition separately.
    terminalWorkbenchVisible: workspaceChromeActive,
    titlebarLeftControlsRef,
    trailingSlotOpen,
    workspaceChromeActive,
    workspaceSidebarOnLeft
  }
}
