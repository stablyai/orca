import { translateMain } from '../i18n/main-i18n'

/** The darwin-only About/Services/Hide/Quit items in the macOS app menu, with
 *  the app's display name interpolated into their localized labels. */
export function buildMacIdentityMenuItems(
  appDisplayName: string
): Electron.MenuItemConstructorOptions[] {
  return [
    {
      role: 'about',
      label: translateMain('menu.about', 'About {{appName}}', { appName: appDisplayName })
    },
    { role: 'services', label: translateMain('menu.services', 'Services') },
    {
      role: 'hide',
      label: translateMain('menu.hide', 'Hide {{appName}}', { appName: appDisplayName })
    },
    { role: 'hideOthers', label: translateMain('menu.hideOthers', 'Hide Others') },
    { role: 'unhide', label: translateMain('menu.unhide', 'Show All') },
    {
      role: 'quit',
      label: translateMain('menu.quit', 'Quit {{appName}}', { appName: appDisplayName })
    }
  ]
}

/** The native Window-menu Minimize/Zoom role items, with localized labels. */
export function buildWindowMenuItems(): Electron.MenuItemConstructorOptions[] {
  return [
    { role: 'minimize', label: translateMain('menu.minimize', 'Minimize') },
    { role: 'zoom', label: translateMain('menu.zoom', 'Zoom') }
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
    { role: 'undo', label: translateMain('menu.undo', 'Undo'), ...undoRedoOptions },
    { role: 'redo', label: translateMain('menu.redo', 'Redo'), ...undoRedoOptions },
    { role: 'cut', label: translateMain('menu.cut', 'Cut') }
  ]
}
