import type { IpcRenderer } from 'electron'
import { installBrowserGuestEditProtection } from './browser/edit-protection/browser-guest-edit-protection'

// Serve pages run in offscreen windows with no <webview> host, so they take only the guest
// preload's edit observer; its close guard and sync theme read need a desktop embedder.
const { ipcRenderer }: { ipcRenderer: Pick<IpcRenderer, 'send' | 'on'> } = require('electron')
if (process.isMainFrame) {
  installBrowserGuestEditProtection({
    send: (channel, payload) => ipcRenderer.send(channel, payload),
    on: (channel, listener) =>
      ipcRenderer.on(channel, (_event, payload: unknown) => listener(payload))
  })
}
