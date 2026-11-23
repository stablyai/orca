import { ipcMain } from 'electron'
import { BROWSER_CLIENT_PAGE_RENDERER_REPLY_CHANNEL } from '../../../../shared/browser/client-hosting/browser-client-page-renderer-protocol'
import type { BrowserClientPageRenderer } from './browser-client-page-renderer-contract'
import { BrowserClientPageRendererBridgeRegistry } from './browser-client-page-renderer-bridge'
import type { BrowserClientPageRendererEndpoint } from './browser-client-page-renderer-reply-admission'

let rendererBridges: BrowserClientPageRendererBridgeRegistry | null = null
const rendererWaiters = new Set<() => void>()

export function attachBrowserClientPageRenderer(renderer: BrowserClientPageRendererEndpoint): void {
  getRendererBridges().attachRenderer(renderer)
  const waiters = [...rendererWaiters]
  rendererWaiters.clear()
  for (const waiter of waiters) {
    waiter()
  }
}

/** Runs `listener` once a renderer can mount pages: now, or when the next one attaches. */
export function whenBrowserClientPageRendererAvailable(listener: () => void): void {
  if (getRendererBridges().hasCurrentRenderer()) {
    listener()
  } else {
    rendererWaiters.add(listener)
  }
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
