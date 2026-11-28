import { ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import type { BrowserExtensionWebStoreInstallResult } from '../../../shared/browser/extensions/browser-extension-webstore'
import { respondToBrowserExtensionInstallPrompt } from '../../browser/extensions/permissions/browser-extension-install-prompt'
import { installBrowserExtensionFromWebStore } from '../../browser/extensions/web-store/browser-extension-webstore-service'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'

const installArgs = lazyZodSchema(() =>
  z.object({ profileId: z.string().min(1), input: z.string().min(1).max(2048) })
)
const promptResponse = lazyZodSchema(() =>
  z.object({ requestId: z.string().min(1), accepted: z.boolean() })
)

/** Settings "Add from Chrome Web Store" and the install prompt's answer; trusted renderer only. */
export function registerBrowserExtensionWebStoreHandlers(ipc: IpcHandleRegistrar = ipcMain): void {
  if (ipc === ipcMain) {
    ipcMain.removeHandler('browserExtensions:installFromWebStore')
    ipcMain.removeHandler('browserExtensions:respondInstallPrompt')
  }
  ipc.handle(
    'browserExtensions:installFromWebStore',
    (event, args: unknown): Promise<BrowserExtensionWebStoreInstallResult> => {
      const parsed = installArgs.safeParse(args)
      if (!isTrustedBrowserRenderer(event.sender) || !parsed.success) {
        return Promise.resolve({ status: 'failed', error: 'Not allowed' })
      }
      return installBrowserExtensionFromWebStore(
        parsed.data.profileId,
        parsed.data.input,
        event.sender
      )
    }
  )
  ipc.handle('browserExtensions:respondInstallPrompt', (event, args: unknown): boolean => {
    const parsed = promptResponse.safeParse(args)
    if (!isTrustedBrowserRenderer(event.sender) || !parsed.success) {
      return false
    }
    return respondToBrowserExtensionInstallPrompt(event.sender, parsed.data)
  })
}
