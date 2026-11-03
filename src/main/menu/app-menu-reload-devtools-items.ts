import { BrowserWindow, MenuItem, webContents } from 'electron'
import { translateMain } from '../i18n/main-i18n'

/** View > Reload, Force Reload and Toggle Developer Tools, which act on what has focus. */
export function createAppMenuReloadAndDevToolsItems(options: {
  forceReloadShortcutLabel: string
  onBeforeReload?: (options: { ignoreCache: boolean; webContentsId: number }) => void
  /** False when the focused contents belong to no browser page. */
  toggleFocusedPageDevTools?: (focused: Electron.WebContents) => boolean
}): Electron.MenuItemConstructorOptions[] {
  const nativeDevToolsItem = new MenuItem({ role: 'toggleDevTools' })
  const reloadFocusedWindow = (ignoreCache: boolean): void => {
    const webContents = BrowserWindow.getFocusedWindow()?.webContents
    if (!webContents) {
      return
    }

    options.onBeforeReload?.({ ignoreCache, webContentsId: webContents.id })

    if (ignoreCache) {
      webContents.reloadIgnoringCache()
      return
    }

    webContents.reload()
  }

  return [
    {
      label: translateMain('menu.reload', 'Reload'),
      click: () => reloadFocusedWindow(false)
    },
    {
      label: `${translateMain('menu.forceReload', 'Force Reload')}\t${options.forceReloadShortcutLabel}`,
      click: () => reloadFocusedWindow(true)
    },
    {
      // Browser pages use Orca's dock lifecycle; other contents retain Electron's native routing.
      label: translateMain('menu.toggleDevTools', 'Toggle Developer Tools'),
      accelerator: nativeDevToolsItem.accelerator ?? undefined,
      click: (_item, window, event) => {
        const focused = webContents.getFocusedWebContents()
        if (focused && options.toggleFocusedPageDevTools?.(focused)) {
          return
        }
        nativeDevToolsItem.click(event, window, focused)
      }
    }
  ]
}
