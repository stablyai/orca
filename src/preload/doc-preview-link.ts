import {
  installDocPreviewLinkInterception,
  PRELOAD_DOC_PREVIEW_LINK_CLICK_CHANNEL
} from './doc-preview-link-interception'
import type { IpcRenderer, WebFrame } from 'electron'
import { installNativeChatVisualGuestTheme } from './native-chat-visual-guest-theme'
import { installBrowserGuestEditProtection } from './browser-guest-edit-protection'

// Raw require keeps the sandboxed preload standalone in the CJS build.
const electron: {
  ipcRenderer: Pick<IpcRenderer, 'send' | 'sendSync' | 'on'>
  webFrame: WebFrame
} = require('electron')
const { ipcRenderer, webFrame } = electron
if (process.isMainFrame) {
  installBrowserGuestEditProtection({
    send: (channel, payload) => ipcRenderer.send(channel, payload),
    on: (channel, listener) =>
      ipcRenderer.on(channel, (_event, payload: unknown) => listener(payload))
  })
}
installNativeChatVisualGuestTheme(ipcRenderer, webFrame)

// Keep the reporter in the isolated world so the document cannot call it through contextBridge.
installDocPreviewLinkInterception((url, modifiers) => {
  ipcRenderer.send(PRELOAD_DOC_PREVIEW_LINK_CLICK_CHANNEL, url, modifiers)
})
