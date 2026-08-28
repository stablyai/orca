import { ipcMain } from 'electron'
import { BROWSER_CLIENT_PAGE_RENDERER_REPLY_CHANNEL } from '../../shared/browser-client-page-renderer-protocol'
import type { BrowserClientPageRenderer } from './browser-client-page-cleanup'
import {
  BrowserClientPageRendererBridgeRegistry,
  type BrowserClientPageRendererEndpoint
} from './browser-client-page-renderer-bridge'

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
