export function createAppWindowMenu(
  label: string,
  isMac: boolean,
  leadingItems: Electron.MenuItemConstructorOptions[] = []
): Electron.MenuItemConstructorOptions {
  return {
    label,
    submenu: [
      ...leadingItems,
      {
        // Electron's minimize role would steal Ctrl+M from terminal apps.
        role: 'minimize',
        ...(isMac ? {} : { accelerator: '', registerAccelerator: false })
      },
      { role: 'zoom' }
    ]
  }
}
