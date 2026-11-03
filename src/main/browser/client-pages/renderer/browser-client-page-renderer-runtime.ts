import { ipcMain } from 'electron'
import { BROWSER_CLIENT_PAGE_RENDERER_REPLY_CHANNEL } from '../../../../shared/browser-client-page-renderer-protocol'
import type { BrowserClientPageRenderer } from '../lifecycle/browser-client-page-cleanup'
import { BrowserClientPageRendererBridgeRegistry } from './browser-client-page-renderer-bridge'
import type { BrowserClientPageRendererEndpoint } from './browser-client-page-renderer-reply-admission'

let rendererBridges: BrowserClientPageRendererBridgeRegistry | null = null

export function attachBrowserClientPageRenderer(renderer: BrowserClientPageRendererEndpoint): void {
  getRendererBridges().attachRenderer(renderer)
}

export function retireBrowserClientPageRenderer(
  renderer: BrowserClientPageRendererEndpoint
): boolean {
  return rendererBridges?.retireRenderer(renderer) ?? false
}

export function selectBrowserClientPageRenderer(): BrowserClientPageRenderer {
  return getRendererBridges().selectRenderer()
}

function getRendererBridges(): BrowserClientPageRendererBridgeRegistry {
  rendererBridges ??= new BrowserClientPageRendererBridgeRegistry({
    transport: {
      onReply: (listener) => ipcMain.on(BROWSER_CLIENT_PAGE_RENDERER_REPLY_CHANNEL, listener),
      offReply: (listener) =>
        ipcMain.removeListener(BROWSER_CLIENT_PAGE_RENDERER_REPLY_CHANNEL, listener)
    }
  })
  return rendererBridges
}
