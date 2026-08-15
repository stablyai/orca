import { useShallow } from 'zustand/react/shallow'
import { canShowRightSidebarForView } from '@/lib/right-sidebar-visibility'
import { isFloatingWorkspacePanelFocused } from '@/lib/floating-workspace-terminal-actions'
import { requestScrollToCurrentWorkspaceRevealAndRename } from '@/lib/scroll-to-current-workspace-status'
import { showTerminalShortcutCaptureNotification } from '@/lib/terminal-shortcut-capture-notification'
import { shouldShowWorktreeHistoryControls } from '../lib/titlebar-worktree-history-controls'
import { TOGGLE_WORKSPACE_BOARD_EVENT } from '../components/sidebar/useWorkspaceBoardPanel'
import { useAppStore } from '../store'
import type { usePluginCommands } from '@/store/plugin-panels'
import { isGitRepoKind } from '../../../shared/repo-kind'
import type {
  KeybindingActionId,
  KeybindingContext,
  PhysicalModifierToken
} from '../../../shared/keybindings'
import { shortcutPlatform } from './app-window-chrome'

type AppStoreState = ReturnType<typeof useAppStore.getState>

// Abstraction over a real KeyboardEvent and a synthetic double-tap gesture so one dispatch path serves both; KeybindingInput-compatible.
export type ShortcutDispatchInput = {
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

export type AppShortcutActions = ReturnType<typeof useAppShortcutActions>

export type AppShortcutState = {
  activeView: AppStoreState['activeView']
  activeWorktreeId: AppStoreState['activeWorktreeId']
  actions: AppShortcutActions
  creationLayoutActive: boolean
  floatingTerminalEnabled: boolean
  floatingTerminalOpen: boolean
  floatingVisibleTabCount: number
  keybindings: AppStoreState['keybindings']
  openFloatingWorkspaceMaximized: () => void
  pluginCommands: ReturnType<typeof usePluginCommands>
  setFloatingTerminalOpen: (open: boolean) => void
  terminalShortcutPolicy: NonNullable<AppStoreState['settings']>['terminalShortcutPolicy']
  workspaceChromeActive: boolean
}

export function useAppShortcutActions() {
  // Why: consolidate action refs into one useShallow subscription so React runs one equality check per store mutation instead of one per action.
  return useAppStore(
    useShallow((s) => ({
      toggleSidebar: s.toggleSidebar,
      toggleRightSidebar: s.toggleRightSidebar,
      setRightSidebarOpen: s.setRightSidebarOpen,
      setRightSidebarTab: s.setRightSidebarTab,
      showRightSidebarFiles: s.showRightSidebarFiles,
      showRightSidebarSearch: s.showRightSidebarSearch,
      openDiffNotesSendMenuForActiveWorktree: s.openDiffNotesSendMenuForActiveWorktree
    }))
  )
}

export function getKeybindingContext(target: EventTarget | null): KeybindingContext {
  return target instanceof HTMLElement && target.classList.contains('xterm-helper-textarea')
    ? 'terminal'
    : 'app'
}

/**
 * Builds the app-level handlers for every keybindable action. Each returns whether it claimed
 * the chord, so an unavailable surface (settings view, closed floating panel) falls through to
 * the terminal or the next handler instead of silently no-opping.
 *
 * `input` is absent when a command is invoked from the palette/menu rather than a key event.
 */
export function createAppCommandHandlers(
  state: AppShortcutState,
  input?: ShortcutDispatchInput,
  keybindingContext: KeybindingContext = 'app'
): Map<KeybindingActionId, () => boolean> {
  const {
    activeView,
    activeWorktreeId,
    actions,
    creationLayoutActive,
    floatingTerminalEnabled,
    floatingTerminalOpen,
    keybindings,
    openFloatingWorkspaceMaximized,
    terminalShortcutPolicy,
    workspaceChromeActive
  } = state
  const floatingWorkspaceFocused = isFloatingWorkspacePanelFocused()
  const canRevealRightSidebar = !creationLayoutActive && canShowRightSidebarForView(activeView)
  const claim = (actionId: KeybindingActionId, run: () => void): boolean => {
    input?.preventDefault()
    if (
      input &&
      keybindingContext === 'terminal' &&
      (terminalShortcutPolicy ?? 'orca-first') === 'orca-first'
    ) {
      showTerminalShortcutCaptureNotification({
        actionId,
        platform: shortcutPlatform,
        keybindings
      })
    }
    run()
    return true
  }
  const revealRightSidebarTab = (
    actionId: KeybindingActionId,
    tab: Parameters<AppShortcutActions['setRightSidebarTab']>[0]
  ): boolean =>
    canRevealRightSidebar
      ? claim(actionId, () => {
          actions.setRightSidebarTab(tab)
          actions.setRightSidebarOpen(true)
        })
      : false

  return new Map<KeybindingActionId, () => boolean>([
    [
      'worktree.history.back',
      () => {
        if (creationLayoutActive || !shouldShowWorktreeHistoryControls(activeView)) {
          return false
        }
        return claim('worktree.history.back', () => useAppStore.getState().goBackWorktree())
      }
    ],
    [
      'worktree.history.forward',
      () => {
        if (creationLayoutActive || !shouldShowWorktreeHistoryControls(activeView)) {
          return false
        }
        return claim('worktree.history.forward', () => useAppStore.getState().goForwardWorktree())
      }
    ],
    ['sidebar.left.toggle', () => claim('sidebar.left.toggle', () => actions.toggleSidebar())],
    [
      'sidebar.sleepingWorkspaces.toggle',
      () =>
        claim('sidebar.sleepingWorkspaces.toggle', () => {
          const store = useAppStore.getState()
          const nextShowSleeping = !store.showSleepingWorkspaces
          store.setShowSleepingWorkspaces(nextShowSleeping)
          if (nextShowSleeping) {
            store.setSidebarOpen(true)
          }
        })
    ],
    [
      'floatingWorkspace.maximize',
      () => {
        if (floatingTerminalOpen || !floatingTerminalEnabled) {
          return false
        }
        return claim('floatingWorkspace.maximize', openFloatingWorkspaceMaximized)
      }
    ],
    [
      'tab.rename',
      () => {
        const store = useAppStore.getState()
        if (
          !workspaceChromeActive ||
          floatingWorkspaceFocused ||
          store.activeTabType !== 'terminal' ||
          !store.activeTabId
        ) {
          return false
        }
        return claim('tab.rename', () => store.setRenamingTabId(store.activeTabId!))
      }
    ],
    [
      'workspace.rename',
      () => {
        if (!workspaceChromeActive || floatingWorkspaceFocused || !activeWorktreeId) {
          return false
        }
        return claim('workspace.rename', () => {
          useAppStore.getState().setSidebarOpen(true)
          requestScrollToCurrentWorkspaceRevealAndRename()
        })
      }
    ],
    [
      'workspace.openBoard',
      () => {
        if (activeView === 'settings') {
          return false
        }
        return claim('workspace.openBoard', () => {
          useAppStore.getState().setSidebarOpen(true)
          window.dispatchEvent(new CustomEvent(TOGGLE_WORKSPACE_BOARD_EVENT))
        })
      }
    ],
    [
      'view.tasks',
      () => {
        const store = useAppStore.getState()
        if (activeView === 'settings' || !store.repos.some((repo) => isGitRepoKind(repo))) {
          return false
        }
        return claim('view.tasks', () => store.openTaskPage())
      }
    ],
    [
      'sidebar.right.toggle',
      () =>
        canRevealRightSidebar
          ? claim('sidebar.right.toggle', () => actions.toggleRightSidebar())
          : false
    ],
    [
      'sidebar.explorer.toggle',
      () =>
        canRevealRightSidebar
          ? claim('sidebar.explorer.toggle', () => actions.showRightSidebarFiles())
          : false
    ],
    [
      'sidebar.search.toggle',
      () =>
        canRevealRightSidebar
          ? claim('sidebar.search.toggle', () => actions.showRightSidebarSearch())
          : false
    ],
    [
      'sidebar.sourceControl.toggle',
      () =>
        // Why: the terminal's own find bar owns this chord while it is open.
        document.querySelector('[data-terminal-search-root]')
          ? false
          : revealRightSidebarTab('sidebar.sourceControl.toggle', 'source-control')
    ],
    ['sidebar.checks.toggle', () => revealRightSidebarTab('sidebar.checks.toggle', 'checks')],
    ['sidebar.ports.toggle', () => revealRightSidebarTab('sidebar.ports.toggle', 'ports')]
  ])
}
