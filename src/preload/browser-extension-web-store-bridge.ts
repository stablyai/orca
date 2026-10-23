import type { ContextBridge, IpcRenderer } from 'electron'
import {
  installChromeWebStoreApis,
  type ChromeWebStoreBridgeReply,
  type ChromeWebStoreMainWorldBridge
} from './browser-extension-web-store-main-world'
import { adaptChromeWebStoreWordingForOrca } from './browser-extension-web-store-wording'

/**
 * Written out here (a test pins them to src/shared/browser-extension-webstore.ts): this module is
 * bundled into a sandboxed preload that cannot load shared chunks.
 */
/** Exact origin only: a prefix match would hand install rights to look-alike hosts. */
export const CHROME_WEB_STORE_ORIGIN = 'https://chromewebstore.google.com'
export const PRELOAD_WEB_STORE_CHANNEL = 'browserExtension:webStore'
export const PRELOAD_WEB_STORE_EVENT_CHANNEL = 'browserExtension:webStoreEvent'

/**
 * The store page's "Add to Chrome" bridge. Main re-checks the sender (exact origin, top frame,
 * Orca browser tab in a local profile) on every call; this side only relays.
 */
export function installChromeWebStoreBridge(): void {
  // Why: raw require keeps the sandboxed preload standalone in the main-process CJS build.
  const electron: { contextBridge: ContextBridge; ipcRenderer: IpcRenderer } = require('electron')
  const { contextBridge, ipcRenderer } = electron
  let dispatch: ((event: string, args: unknown[]) => void) | null = null
  ipcRenderer.on(PRELOAD_WEB_STORE_EVENT_CHANNEL, (_event, payload: unknown) => {
    if (payload && typeof payload === 'object' && 'event' in payload && 'args' in payload) {
      const { event, args } = payload
      if (typeof event === 'string' && Array.isArray(args)) {
        dispatch?.(event, args)
      }
    }
  })
  const bridge: ChromeWebStoreMainWorldBridge = {
    call: async (method, args) => {
      try {
        const reply: ChromeWebStoreBridgeReply = await ipcRenderer.invoke(
          PRELOAD_WEB_STORE_CHANNEL,
          { method, args }
        )
        return reply
      } catch {
        return { error: 'Orca could not handle this request' }
      }
    },
    onEvent: (handler) => {
      dispatch = handler
    }
  }
  contextBridge.executeInMainWorld({
    func: installChromeWebStoreApis,
    args: [bridge, typeof process !== 'undefined' ? (process.versions.chrome ?? '') : '']
  })
  contextBridge.executeInMainWorld({ func: adaptChromeWebStoreWordingForOrca })
}
