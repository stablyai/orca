import { nativeRoleLabel } from './native-role-label'
import { createAppMenuQuitItem } from './app-menu-quit-item'

/** Combines macOS role items with host-provided Settings, update and Quit behavior. */
export function buildMacAppMenu(
  appDisplayName: string,
  checkForUpdatesItem: Electron.MenuItemConstructorOptions,
  settingsItem: Electron.MenuItemConstructorOptions,
  onQuit?: () => void
): Electron.MenuItemConstructorOptions {
  const [about, services, hide, hideOthers, unhide] = buildMacIdentityMenuItems(appDisplayName)
  return {
    label: appDisplayName,
    submenu: [
      about,
      checkForUpdatesItem,
      settingsItem,
      { type: 'separator' },
      services,
      { type: 'separator' },
      hide,
      hideOthers,
      unhide,
      { type: 'separator' },
      createAppMenuQuitItem(onQuit, appDisplayName)
    ]
  }
}

/** The darwin-only About/Services/Hide items in the macOS app menu, with
 *  the app's display name interpolated into their localized labels. */
export function buildMacIdentityMenuItems(
  appDisplayName: string
): Electron.MenuItemConstructorOptions[] {
  return [
    {
      role: 'about',
      label: nativeRoleLabel('menu.about', 'About {{appName}}', { appName: appDisplayName })
    },
    { role: 'services', label: nativeRoleLabel('menu.services', 'Services') },
    {
      role: 'hide',
      label: nativeRoleLabel('menu.hide', 'Hide {{appName}}', { appName: appDisplayName })
    },
    { role: 'hideOthers', label: nativeRoleLabel('menu.hideOthers', 'Hide Others') },
    { role: 'unhide', label: nativeRoleLabel('menu.unhide', 'Show All') }
  ]
}

/** The Edit-menu Undo/Redo/Cut role items, with localized labels. Non-macOS
 *  disables the accelerator so Ctrl+Z/Ctrl+Y can reach the focused terminal
 *  or DOM control instead of the native role handler. */
export function buildEditMenuNativeItems(isMac: boolean): Electron.MenuItemConstructorOptions[] {
  const undoRedoOptions: Electron.MenuItemConstructorOptions = isMac
    ? {}
    : { registerAccelerator: false }
  return [
    { role: 'undo', label: nativeRoleLabel('menu.undo', 'Undo'), ...undoRedoOptions },
    { role: 'redo', label: nativeRoleLabel('menu.redo', 'Redo'), ...undoRedoOptions },
    { role: 'cut', label: nativeRoleLabel('menu.cut', 'Cut') }
  ]
}
