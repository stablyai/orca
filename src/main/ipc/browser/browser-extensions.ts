import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import { ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
import { z } from 'zod'
import { isChromeExtensionId } from '../../../shared/browser/extensions/browser-extension-url'
import type {
  BrowserExtensionActionResult,
  BrowserExtensionListResult
} from '../../../shared/browser/extensions/browser-extension-types'
import {
  addUnpackedBrowserExtension,
  listBrowserExtensionsForProfile,
  openBrowserExtensionOptions,
  reloadUnpackedBrowserExtension,
  removeBrowserExtension,
  reviewBrowserExtensionUpdate,
  setBrowserExtensionEnabled
} from '../../browser/extensions/browser-extension-management'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'
import { registerBrowserExtensionToolbarHandlers } from './browser-extension-toolbar'
import { registerBrowserExtensionSidePanelHandlers } from './browser-extension-side-panels'
import { registerBrowserExtensionWebStoreHandlers } from './browser-extension-webstore'

const profileArgs = lazyZodSchema(() => z.object({ profileId: z.string().min(1) }))
const extensionArgs = lazyZodSchema(() =>
  profileArgs.extend({ extensionId: z.string().refine(isChromeExtensionId) })
)
const UNTRUSTED: BrowserExtensionActionResult = { ok: false, error: 'Not allowed' }

const CHANNELS = [
  'browserExtensions:list',
  'browserExtensions:setEnabled',
  'browserExtensions:remove',
  'browserExtensions:loadUnpacked',
  'browserExtensions:reload',
  'browserExtensions:openOptions',
  'browserExtensions:reviewUpdate'
] as const

/** Settings › Browser › Extensions; only the trusted Orca renderer may manage extensions. */
export function registerBrowserExtensionHandlers(ipc: IpcHandleRegistrar = ipcMain): void {
  if (ipc === ipcMain) {
    for (const channel of CHANNELS) {
      ipcMain.removeHandler(channel)
    }
  }
  registerBrowserExtensionToolbarHandlers(ipc)
  registerBrowserExtensionSidePanelHandlers(ipc)
  registerBrowserExtensionWebStoreHandlers(ipc)
  ipc.handle(
    'browserExtensions:list',
    (event, args: unknown): Promise<BrowserExtensionListResult> => {
      const parsed = profileArgs.safeParse(args)
      if (!isTrustedBrowserRenderer(event.sender) || !parsed.success) {
        return Promise.resolve({ active: false, extensions: [] })
      }
      return listBrowserExtensionsForProfile(parsed.data.profileId)
    }
  )
  ipc.handle('browserExtensions:setEnabled', (event, args: unknown) => {
    const parsed = extensionArgs.extend({ enabled: z.boolean() }).safeParse(args)
    if (!isTrustedBrowserRenderer(event.sender) || !parsed.success) {
      return UNTRUSTED
    }
    const { profileId, extensionId, enabled } = parsed.data
    return setBrowserExtensionEnabled(profileId, extensionId, enabled)
  })
  ipc.handle('browserExtensions:remove', (event, args: unknown) => {
    const parsed = extensionArgs.safeParse(args)
    if (!isTrustedBrowserRenderer(event.sender) || !parsed.success) {
      return UNTRUSTED
    }
    return removeBrowserExtension(parsed.data.extensionId)
  })
  ipc.handle('browserExtensions:loadUnpacked', (event, args: unknown) => {
    const parsed = profileArgs.extend({ directory: z.string().min(1) }).safeParse(args)
    if (!isTrustedBrowserRenderer(event.sender) || !parsed.success) {
      return UNTRUSTED
    }
    return addUnpackedBrowserExtension(parsed.data.profileId, parsed.data.directory)
  })
  ipc.handle('browserExtensions:reload', (event, args: unknown) => {
    const parsed = extensionArgs.safeParse(args)
    if (!isTrustedBrowserRenderer(event.sender) || !parsed.success) {
      return UNTRUSTED
    }
    return reloadUnpackedBrowserExtension(parsed.data.extensionId)
  })
  ipc.handle('browserExtensions:openOptions', (event, args: unknown) => {
    const parsed = extensionArgs.safeParse(args)
    if (!isTrustedBrowserRenderer(event.sender) || !parsed.success) {
      return UNTRUSTED
    }
    return openBrowserExtensionOptions(parsed.data.profileId, parsed.data.extensionId)
  })
  ipc.handle('browserExtensions:reviewUpdate', (event, args: unknown) => {
    const parsed = extensionArgs.safeParse(args)
    if (!isTrustedBrowserRenderer(event.sender) || !parsed.success) {
      return UNTRUSTED
    }
    return reviewBrowserExtensionUpdate(parsed.data.extensionId, event.sender)
  })
}
