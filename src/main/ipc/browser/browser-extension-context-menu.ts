import { ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import type { BrowserExtensionContextMenuPayload } from '../../../shared/browser/extensions/browser-extension-context-menu-types'
import { isChromeExtensionId } from '../../../shared/browser/extensions/browser-extension-url'
import { browserManager } from '../../browser/guest-lifecycle/manager/browser-manager'
import {
  buildBrowserExtensionActionContextMenu,
  runBrowserExtensionContextMenuClick
} from '../../browser/extensions/context-menus/browser-extension-context-menu-host'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'

const CLICK_CHANNEL = 'browserExtensions:contextMenuClick'
const ACTION_MENU_CHANNEL = 'browserExtensions:actionContextMenu'
const extensionId = lazyZodSchema(() => z.string().refine(isChromeExtensionId))
const clickArgs = lazyZodSchema(() =>
  z.object({ token: z.string().min(1), extensionId, key: z.string().min(1) })
)
const actionMenuArgs = lazyZodSchema(() =>
  z.object({
    profileId: z.string().min(1),
    extensionId,
    browserPageId: z.string().min(1).optional()
  })
)

/** Extension items in Orca's page and toolbar-button menus; main owns what was clicked on. */
export function registerBrowserExtensionContextMenuHandlers(
  ipc: IpcHandleRegistrar = ipcMain
): void {
  if (ipc === ipcMain) {
    ipcMain.removeHandler(CLICK_CHANNEL)
    ipcMain.removeHandler(ACTION_MENU_CHANNEL)
  }
  ipc.handle(CLICK_CHANNEL, (event, args: unknown): boolean => {
    const parsed = clickArgs.safeParse(args)
    if (!isTrustedBrowserRenderer(event.sender) || !parsed.success) {
      return false
    }
    return runBrowserExtensionContextMenuClick(parsed.data)
  })
  ipc.handle(
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
