import { labeledAppMenuRole } from './labeled-app-menu-role'

export function createAppWindowMenu(
  label: string,
  isMac: boolean
): Electron.MenuItemConstructorOptions {
  return {
    label,
    // Registers via -[NSApp setWindowsMenu:] so macOS adds the window list and tiling items.
    ...(isMac ? { role: 'window' as const } : {}),
    submenu: [
      {
        ...labeledAppMenuRole('minimize', 'menu.minimize', 'Minimize'),
        // Why: Electron's minimize role otherwise steals Ctrl+M from terminal apps.
        ...(isMac ? {} : { accelerator: '', registerAccelerator: false })
      },
      labeledAppMenuRole('zoom', 'menu.zoom', 'Zoom')
    ]
  }
}
