import { labeledAppMenuRole } from './labeled-app-menu-role'

export function createMacApplicationMenu(items: {
  label: string
  checkForUpdates: Electron.MenuItemConstructorOptions
  settings: Electron.MenuItemConstructorOptions
  quit: Electron.MenuItemConstructorOptions | Electron.MenuItemConstructorOptions[]
}): Electron.MenuItemConstructorOptions {
  return {
    label: items.label,
    submenu: [
      labeledAppMenuRole('about', 'menu.about', 'About Orca'),
      items.checkForUpdates,
      items.settings,
      { type: 'separator' },
      labeledAppMenuRole('services', 'menu.services', 'Services'),
      { type: 'separator' },
      labeledAppMenuRole('hide', 'menu.hide', 'Hide Orca'),
      labeledAppMenuRole('hideOthers', 'menu.hideOthers', 'Hide Others'),
      labeledAppMenuRole('unhide', 'menu.unhide', 'Show All'),
      { type: 'separator' },
      ...(Array.isArray(items.quit) ? items.quit : [items.quit])
    ]
  }
}
