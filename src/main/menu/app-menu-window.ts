import { translateMain } from '../i18n/main-i18n'
import { nativeRoleLabel } from './native-role-label'

export function createLocalizedAppWindowMenu(isMac: boolean): Electron.MenuItemConstructorOptions {
  return createAppWindowMenu(translateMain('menu.window', 'Window'), isMac, {
    minimize: nativeRoleLabel('menu.minimize', 'Minimize'),
    zoom: nativeRoleLabel('menu.zoom', 'Zoom')
  })
}

export function createAppWindowMenu(
  label: string,
  isMac: boolean,
  roleLabels: { minimize: string | undefined; zoom: string | undefined }
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
