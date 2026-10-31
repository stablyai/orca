export function createMacApplicationMenu(items: {
  label: string
  checkForUpdates: Electron.MenuItemConstructorOptions
  settings: Electron.MenuItemConstructorOptions
  quit: Electron.MenuItemConstructorOptions | Electron.MenuItemConstructorOptions[]
}): Electron.MenuItemConstructorOptions {
  return {
    label: items.label,
    submenu: [
      { role: 'about' },
      items.checkForUpdates,
      items.settings,
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      ...(Array.isArray(items.quit) ? items.quit : [items.quit])
    ]
  }
}
