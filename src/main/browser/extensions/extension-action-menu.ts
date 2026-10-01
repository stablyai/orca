import { BrowserWindow, dialog, Menu, MenuItem, type Session, type WebContents } from 'electron'
import { translateMain } from '../../i18n/main-i18n'
import { objectArg } from './extension-api-args'
import { presentExtensionWindow } from './extension-action-state'
import { extensionActionMenuItems } from './extension-context-menus'
import { removeBrowserExtension } from './extension-sessions'
import { lastExtensionTab, openExtensionTab } from './extension-tab-registry'

/** The options page a manifest declares, as a URL; null when it has none. */
export function extensionOptionsUrl(extension: {
  url: string
  manifest: Record<string, unknown>
}): string | null {
  const page: unknown =
    objectArg(extension.manifest.options_ui).page ?? extension.manifest.options_page
  return typeof page === 'string' ? new URL(page, extension.url).href : null
}

/** Opens the options page in an Orca tab, or its own window when no browser tab is open. */
export function openExtensionOptions(session: Session, extensionId: string): void {
  const extension = session.extensions.getExtension(extensionId)
  const url = extension && extensionOptionsUrl(extension)
  if (!url) {
    return
  }
  const tab = lastExtensionTab()
  if (tab && tab.session === session) {
    void openExtensionTab(url, true).catch(() => {})
    return
  }
  const window = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: { session }
  })
  presentExtensionWindow(window)
  void window.loadURL(url)
}

async function confirmRemove(window: BrowserWindow, extension: Electron.Extension) {
  const { response } = await dialog.showMessageBox(window, {
    type: 'question',
    message: translateMain(
      'auto.main.browser.browserExtensions.removeTitle',
      'Remove "{{name}}"?',
      { name: extension.name }
    ),
    buttons: [
      translateMain('auto.main.browser.browserExtensions.removeConfirm', 'Remove'),
      translateMain('auto.main.browser.browserExtensions.installCancel', 'Cancel')
    ],
    defaultId: 0,
    cancelId: 1
  })
  if (response === 0) {
    await removeBrowserExtension(extension.id)
  }
}

/** The toolbar button's right-click menu: the extension's own entries, options, and remove. */
export function showExtensionActionMenu(
  tab: WebContents,
  extensionId: string,
  window: BrowserWindow
): void {
  const extension = tab.session.extensions.getExtension(extensionId)
  if (!extension) {
    return
  }
  const menu = new Menu()
  menu.append(new MenuItem({ label: extension.name, enabled: false }))
  const own = extensionActionMenuItems(tab, extension)
  if (own.length > 0) {
    menu.append(new MenuItem({ type: 'separator' }))
    own.forEach((item) => menu.append(item))
  }
  menu.append(new MenuItem({ type: 'separator' }))
  if (extensionOptionsUrl(extension)) {
    menu.append(
      new MenuItem({
        label: translateMain('auto.main.browser.browserExtensions.options', 'Options'),
        click: () => openExtensionOptions(tab.session, extensionId)
      })
    )
  }
  menu.append(
    new MenuItem({
      label: translateMain('auto.main.browser.browserExtensions.remove', 'Remove from Orca…'),
      click: () => void confirmRemove(window, extension)
    })
  )
  menu.popup({ window })
}
