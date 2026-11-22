import {
  installDocPreviewLinkInterception,
  PRELOAD_DOC_PREVIEW_LINK_CLICK_CHANNEL
} from './document-preview/doc-preview-link-interception'
import type { IpcRenderer, WebFrame } from 'electron'
import { installNativeChatVisualGuestTheme } from './native-chat/native-chat-visual-guest-theme'
import { installBrowserGuestEditProtection } from './browser/edit-protection/browser-guest-edit-protection'
import { installBrowserGuestPageVisibilityReport } from './browser/visibility/browser-guest-page-visibility-report'
import { BROWSER_GUEST_PAGE_VISIBILITY_CHANNEL } from '../shared/browser/guest-lifecycle/browser-guest-page-visibility'

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
// A preview in a background tab is a webview too; see browser-guest.ts.
installBrowserGuestPageVisibilityReport((state) =>
  ipcRenderer.send(BROWSER_GUEST_PAGE_VISIBILITY_CHANNEL, state)
)

// Keep the reporter in the isolated world so the document cannot call it through contextBridge.
installDocPreviewLinkInterception((url, modifiers) => {
  ipcRenderer.send(PRELOAD_DOC_PREVIEW_LINK_CLICK_CHANNEL, url, modifiers)
})
