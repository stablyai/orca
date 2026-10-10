import type { ContextBridge, IpcRenderer } from 'electron'
import {
  BROWSER_EXTENSION_API,
  BROWSER_EXTENSION_CALL_CHANNEL,
  BROWSER_EXTENSION_EVENT_CHANNEL,
  BROWSER_EXTENSION_PRIVACY_SETTINGS
} from './browser-extension-api-spec'
import { installBrowserExtensionApi } from './browser-extension-api-install'

// Why raw require: an ESM import of electron adds an interop chunk this sandboxed preload cannot load.
const {
  contextBridge,
  ipcRenderer
}: { contextBridge: ContextBridge; ipcRenderer: IpcRenderer } = require('electron')

// Runs in every frame and service worker of an extension-enabled session; only extension contexts
// get the APIs, so web pages never see the bridge.
if (process.type === 'service-worker' || location.protocol === 'chrome-extension:') {
  contextBridge.executeInMainWorld({
    func: installBrowserExtensionApi,
    args: [
      BROWSER_EXTENSION_API,
      BROWSER_EXTENSION_PRIVACY_SETTINGS,
      (namespace: string, method: string, args: unknown[]) =>
        ipcRenderer.invoke(BROWSER_EXTENSION_CALL_CHANNEL, { namespace, method, args }),
      (dispatch: (key: string, args: unknown[]) => void) => {
        ipcRenderer.on(BROWSER_EXTENSION_EVENT_CHANNEL, (_event, key: string, args: unknown[]) =>
          dispatch(key, args)
        )
      }
    ]
  })
}
