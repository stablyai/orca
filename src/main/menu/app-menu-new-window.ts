import { translateMain } from '../i18n/main-i18n'

export function createNewWindowMenuItems(
  enabled: boolean | undefined,
  onNewWindow: (() => void) | undefined
): Electron.MenuItemConstructorOptions[] {
  return enabled && onNewWindow
    ? [
        {
          id: 'new-window',
          label: translateMain('menu.newWindow', 'New Window'),
          click: onNewWindow
        }
      ]
    : []
}
