import type { KeybindingActionId } from '../../shared/keybindings'
import { normalizeWorkspaceSidebarPosition } from '../../shared/workspace-sidebar-position'
import { translateMain } from '../i18n/main-i18n'

type SidebarToggleMenuOptions = {
  getWorkspaceSidebarPosition?: () => unknown
  /** Toggles the workspace list (Mod+B). */
  onToggleLeftSidebar: () => void
  /** Toggles the activity sidebar (Mod+L). */
  onToggleRightSidebar: () => void
}

/**
 * Both entries keep their own shortcut but are named by the edge their panel sits on, so the menu
 * matches the titlebar toggles after the sidebars swap.
 * Why: display-only shortcut hints, not accelerators — Cmd/Ctrl+B is intercepted in
 * createMainWindow.ts's before-input-event handler with a TipTap-bold carve-out the menu would bypass.
 */
export function buildSidebarToggleMenuItems(
  {
    getWorkspaceSidebarPosition,
    onToggleLeftSidebar,
    onToggleRightSidebar
  }: SidebarToggleMenuOptions,
  shortcutLabel: (actionId: KeybindingActionId) => string
): Electron.MenuItemConstructorOptions[] {
  const workspaceOnLeft =
    normalizeWorkspaceSidebarPosition(getWorkspaceSidebarPosition?.()) === 'left'
  const label = (edge: 'left' | 'right', actionId: KeybindingActionId): string =>
    `${
      edge === 'left'
        ? translateMain('menu.toggleLeftSidebar', 'Toggle Left Sidebar')
        : translateMain('menu.toggleRightSidebar', 'Toggle Right Sidebar')
    }\t${shortcutLabel(actionId)}`
  const workspaceItem: Electron.MenuItemConstructorOptions = {
    label: label(workspaceOnLeft ? 'left' : 'right', 'sidebar.left.toggle'),
    click: () => onToggleLeftSidebar()
  }
  const activityItem: Electron.MenuItemConstructorOptions = {
    label: label(workspaceOnLeft ? 'right' : 'left', 'sidebar.right.toggle'),
    click: () => onToggleRightSidebar()
  }
  return workspaceOnLeft ? [workspaceItem, activityItem] : [activityItem, workspaceItem]
}
