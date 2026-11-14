import type { ContextBridge, IpcRenderer, WebFrame } from 'electron'
import { installBrowserPasswordDetector } from './browser/passwords/browser-password-detector'
import {
  installBrowserWindowCloseGuard,
  PRELOAD_BROWSER_GUEST_WINDOW_CLOSE_CHANNEL
} from './browser/window-controls/browser-window-close-installation'
import { installBrowserWindowPrompt } from './browser/window-controls/browser-window-prompt-installation'
import { installNativeChatVisualGuestTheme } from './native-chat/native-chat-visual-guest-theme'

// Raw require keeps the sandboxed preload standalone in the CJS build.
const electron: {
  contextBridge: ContextBridge
  ipcRenderer: Pick<IpcRenderer, 'send' | 'sendToHost' | 'sendSync' | 'on'>
  webFrame: WebFrame
} = require('electron')
const { contextBridge, ipcRenderer } = electron
installNativeChatVisualGuestTheme(ipcRenderer, electron.webFrame)

// Subframe window.close() is already inert; preserve the frame's own implementation.
if (process.isMainFrame) {
  contextBridge.executeInMainWorld({
    func: installBrowserWindowCloseGuard,
    args: [() => ipcRenderer.sendToHost(PRELOAD_BROWSER_GUEST_WINDOW_CLOSE_CHANNEL)]
  })
}
// Every frame this preload runs in also got Electron's throwing prompt.
contextBridge.executeInMainWorld({ func: installBrowserWindowPrompt, args: [] })

// Why no contextBridge exposure: page script must not be able to call into the detector.
installBrowserPasswordDetector({
  send: (channel, payload) => ipcRenderer.send(channel, payload),
  on: (channel, listener) => {
    ipcRenderer.on(channel, (_event, payload: unknown) => listener(payload))
  }
})
