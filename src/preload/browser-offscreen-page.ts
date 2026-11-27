import type { IpcRenderer, WebFrame } from 'electron'
import { installBrowserGuestEditProtection } from './browser/edit-protection/browser-guest-edit-protection'
import { installBrowserGuestExecution } from './browser/element-grab/browser-guest-execution'

// Serve pages run in offscreen windows with no <webview> host, so they take only the guest
// preload's edit observer and the grab execution lane (streamed viewers pick through it); its close
// guard, sync theme read and native tool keys need a desktop embedder.
const {
  ipcRenderer,
  webFrame
}: { ipcRenderer: Pick<IpcRenderer, 'send' | 'on'>; webFrame: WebFrame } = require('electron')
if (process.isMainFrame) {
  installBrowserGuestExecution(
    {
      send: (channel, payload) => ipcRenderer.send(channel, payload),
      on: (channel, listener) => ipcRenderer.on(channel, (_event, payload) => listener(payload))
    },
    webFrame
  )
  installBrowserGuestEditProtection({
    send: (channel, payload) => ipcRenderer.send(channel, payload),
    on: (channel, listener) =>
      ipcRenderer.on(channel, (_event, payload: unknown) => listener(payload))
  })
}
