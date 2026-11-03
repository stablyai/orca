import { ipcMain } from 'electron'
import { z } from 'zod'
import type { BrowserExtensionContextMenuPayload } from '../../shared/browser-extension-context-menu-types'
import { isChromeExtensionId } from '../../shared/browser-extension-url'
import { browserManager } from '../browser/browser-manager'
import {
  buildBrowserExtensionActionContextMenu,
  runBrowserExtensionContextMenuClick
} from '../browser/extensions/browser-extension-context-menu-host'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'

const CLICK_CHANNEL = 'browserExtensions:contextMenuClick'
const ACTION_MENU_CHANNEL = 'browserExtensions:actionContextMenu'
const extensionId = z.string().refine(isChromeExtensionId)
const clickArgs = z.object({ token: z.string().min(1), extensionId, key: z.string().min(1) })
const actionMenuArgs = z.object({
  profileId: z.string().min(1),
  extensionId,
  browserPageId: z.string().min(1).optional()
})

/** Extension items in Orca's page and toolbar-button menus; main owns what was clicked on. */
export function registerBrowserExtensionContextMenuHandlers(): void {
  ipcMain.removeHandler(CLICK_CHANNEL)
  ipcMain.removeHandler(ACTION_MENU_CHANNEL)
  ipcMain.handle(CLICK_CHANNEL, (event, args: unknown): boolean => {
    const parsed = clickArgs.safeParse(args)
    if (!isTrustedBrowserRenderer(event.sender) || !parsed.success) {
      return false
    }
    return runBrowserExtensionContextMenuClick(parsed.data)
  })
  ipcMain.handle(
    ACTION_MENU_CHANNEL,
    (event, args: unknown): BrowserExtensionContextMenuPayload | null => {
      const parsed = actionMenuArgs.safeParse(args)
      if (!isTrustedBrowserRenderer(event.sender) || !parsed.success) {
        return null
      }
      const { profileId, browserPageId } = parsed.data
      const tabId = browserPageId ? browserManager.getGuestWebContentsId(browserPageId) : null
      return buildBrowserExtensionActionContextMenu(profileId, parsed.data.extensionId, tabId)
    }
  )
}
