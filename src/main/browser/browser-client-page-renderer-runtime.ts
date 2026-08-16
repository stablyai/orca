import { ipcMain } from 'electron'
import { BROWSER_CLIENT_PAGE_RENDERER_REPLY_CHANNEL } from '../../shared/browser-client-page-renderer-protocol'
import type { BrowserClientPageRenderer } from './browser-client-page-cleanup'
import {
  BrowserClientPageRendererBridgeRegistry,
  type BrowserClientPageRendererEndpoint
} from './browser-client-page-renderer-bridge'

const rendererBridges = new BrowserClientPageRendererBridgeRegistry({
  transport: {
    onReply: (listener) => ipcMain.on(BROWSER_CLIENT_PAGE_RENDERER_REPLY_CHANNEL, listener),
    offReply: (listener) =>
      ipcMain.removeListener(BROWSER_CLIENT_PAGE_RENDERER_REPLY_CHANNEL, listener)
  }
})

export function attachBrowserClientPageRenderer(renderer: BrowserClientPageRendererEndpoint): void {
  rendererBridges.attachRenderer(renderer)
}

export function retireBrowserClientPageRenderer(
  renderer: BrowserClientPageRendererEndpoint
): boolean {
  return rendererBridges.retireRenderer(renderer)
}

export function selectBrowserClientPageRenderer(): BrowserClientPageRenderer {
  return rendererBridges.selectRenderer()
}
