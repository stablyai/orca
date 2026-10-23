import { ipcMain } from 'electron'
import { z } from 'zod'
import { isChromeExtensionId } from '../../shared/browser-extension-url'
import type { BrowserExtensionActionResult } from '../../shared/browser-extension-types'
import type { BrowserExtensionToolbarState } from '../../shared/browser-extension-toolbar-types'
import { notifyBrowserExtensionActionsChanged } from '../browser/extensions/browser-extension-action-registry'
import { getBrowserExtensionSessionForProfile } from '../browser/extensions/browser-extension-session-loader'
import { isBrowserExtensionSupportEnabled } from '../browser/extensions/browser-extension-support'
import {
  activateBrowserExtensionAction,
  emitBrowserExtensionActionEvent,
  getBrowserExtensionPageIcon,
  getBrowserExtensionToolbarState
} from '../browser/extensions/browser-extension-toolbar'
import { setBrowserExtensionPinned } from '../browser/extensions/browser-extension-toolbar-pins'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'

const pageArgs = z.object({ browserPageId: z.string().min(1) })
const extensionId = z.string().refine(isChromeExtensionId)
const anchorSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative()
})
const UNTRUSTED: BrowserExtensionActionResult = { ok: false, error: 'Not allowed' }

const CHANNELS = [
  'browserExtensions:toolbarState',
  'browserExtensions:setPinned',
  'browserExtensions:activateAction',
  'browserExtensions:pageIcon'
] as const

/** The browser toolbar's extension buttons; only the trusted Orca renderer may drive them. */
export function registerBrowserExtensionToolbarHandlers(): void {
  for (const channel of CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.handle(
    'browserExtensions:toolbarState',
    (event, args: unknown): Promise<BrowserExtensionToolbarState | null> | null => {
      const parsed = pageArgs.safeParse(args)
      if (!isTrustedBrowserRenderer(event.sender) || !parsed.success) {
        return null
      }
      return isBrowserExtensionSupportEnabled()
        ? getBrowserExtensionToolbarState(parsed.data.browserPageId)
        : null
    }
  )
  ipcMain.handle('browserExtensions:setPinned', (event, args: unknown) => {
    const parsed = z
      .object({ profileId: z.string().min(1), extensionId, pinned: z.boolean() })
      .safeParse(args)
    if (!isTrustedBrowserRenderer(event.sender) || !parsed.success) {
      return UNTRUSTED
    }
    const { profileId, pinned } = parsed.data
    setBrowserExtensionPinned(profileId, parsed.data.extensionId, pinned)
    notifyBrowserExtensionActionsChanged(profileId)
    const sess = getBrowserExtensionSessionForProfile(profileId)
    if (sess) {
      emitBrowserExtensionActionEvent(sess, parsed.data.extensionId, 'onUserSettingsChanged', [
        { isOnToolbar: pinned }
      ])
    }
    return { ok: true } satisfies BrowserExtensionActionResult
  })
  ipcMain.handle('browserExtensions:activateAction', (event, args: unknown) => {
    const parsed = pageArgs
      .extend({ extensionId, anchor: anchorSchema, popupOnly: z.boolean().optional() })
      .safeParse(args)
    if (!isTrustedBrowserRenderer(event.sender) || !parsed.success) {
      return UNTRUSTED
    }
    return activateBrowserExtensionAction({
      ...parsed.data,
      popupOnly: parsed.data.popupOnly === true
    })
  })
  ipcMain.handle('browserExtensions:pageIcon', (event, args: unknown) => {
    const parsed = pageArgs.safeParse(args)
    if (!isTrustedBrowserRenderer(event.sender) || !parsed.success) {
      return null
    }
    return isBrowserExtensionSupportEnabled()
      ? getBrowserExtensionPageIcon(parsed.data.browserPageId)
      : null
  })
}
