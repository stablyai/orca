import { BrowserWindow, webContents } from 'electron'
import { translateMain } from '../i18n/main-i18n'

/** View > Reload, Force Reload and Toggle Developer Tools, which act on what has focus. */
export function createAppMenuReloadAndDevToolsItems(options: {
  forceReloadShortcutLabel: string
  onBeforeReload?: (options: { ignoreCache: boolean; webContentsId: number }) => void
  /** False when the focused contents belong to no browser page. */
  toggleFocusedPageDevTools?: (focused: Electron.WebContents) => boolean
}): Electron.MenuItemConstructorOptions[] {
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
      // Why not role 'toggleDevTools': it always toggles Orca's own DevTools, even while a
      // browser page or its DevTools has focus, where Chrome would toggle the page's.
      label: translateMain('menu.toggleDevTools', 'Toggle Developer Tools'),
      // Same accelerator Electron gives the role.
      accelerator: process.platform === 'darwin' ? 'Alt+Command+I' : 'Ctrl+Shift+I',
      click: () => {
        const focused = webContents.getFocusedWebContents()
        if (focused && options.toggleFocusedPageDevTools?.(focused)) {
          return
        }
        BrowserWindow.getFocusedWindow()?.webContents.toggleDevTools()
      }
    }
  ]
}
