export function createAppWindowMenu(
  label: string,
  isMac: boolean,
  roleLabels: { minimize: string; zoom: string }
): Electron.MenuItemConstructorOptions {
  return {
    label,
    submenu: [
      {
        // Why: Electron's minimize role otherwise steals Ctrl+M from terminal apps such as Crush.
        role: 'minimize',
        label: roleLabels.minimize,
        ...(isMac ? {} : { accelerator: '', registerAccelerator: false })
      },
      { role: 'zoom', label: roleLabels.zoom }
    ]
  }
}
