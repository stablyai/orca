import { ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import type { BrowserExtensionSidePanel } from '../../../shared/browser/extensions/browser-extension-side-panel-types'
import {
  closeBrowserExtensionSidePanelById,
  listBrowserExtensionSidePanels,
  noteBrowserExtensionSidePanelShown
} from '../../browser/extensions/side-panel/browser-extension-side-panel-host'
import { prepareBrowserExtensionSidePanelAttach } from '../../browser/extensions/side-panel/browser-extension-side-panel-attach'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'

const panelArgs = lazyZodSchema(() => z.object({ panelId: z.string().min(1) }))

const CHANNELS = [
  'browserExtensions:sidePanels',
  'browserExtensions:sidePanelAttach',
  'browserExtensions:sidePanelClose',
  'browserExtensions:sidePanelShown'
] as const

/** The renderer lays out the panels main opened; only the trusted Orca renderer may ask. */
export function registerBrowserExtensionSidePanelHandlers(ipc: IpcHandleRegistrar = ipcMain): void {
  if (ipc === ipcMain) {
    for (const channel of CHANNELS) {
      ipcMain.removeHandler(channel)
    }
  }
  ipc.handle('browserExtensions:sidePanels', (event): BrowserExtensionSidePanel[] =>
    isTrustedBrowserRenderer(event.sender) ? listBrowserExtensionSidePanels() : []
  )
  ipc.handle('browserExtensions:sidePanelAttach', (event, args: unknown): string | null => {
    const parsed = panelArgs.safeParse(args)
    return isTrustedBrowserRenderer(event.sender) && parsed.success
      ? prepareBrowserExtensionSidePanelAttach(parsed.data.panelId)
      : null
  })
  ipc.handle('browserExtensions:sidePanelShown', (event, args: unknown): void => {
    const parsed = panelArgs.extend({ browserPageId: z.string().min(1) }).safeParse(args)
    if (isTrustedBrowserRenderer(event.sender) && parsed.success) {
      noteBrowserExtensionSidePanelShown(parsed.data.panelId, parsed.data.browserPageId)
    }
  })
  ipc.handle('browserExtensions:sidePanelClose', (event, args: unknown): void => {
    const parsed = panelArgs.safeParse(args)
    if (isTrustedBrowserRenderer(event.sender) && parsed.success) {
      closeBrowserExtensionSidePanelById(parsed.data.panelId)
    }
  })
}
