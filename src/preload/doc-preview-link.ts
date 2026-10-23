import {
  installDocPreviewLinkInterception,
  PRELOAD_DOC_PREVIEW_LINK_CLICK_CHANNEL
} from './doc-preview-link-interception'

// Raw require keeps the sandboxed preload standalone in the CJS build.
const { ipcRenderer } = require('electron') as {
  ipcRenderer: { send: (channel: string, ...args: unknown[]) => void }
}

// Keep the reporter in the isolated world so the document cannot call it through contextBridge.
installDocPreviewLinkInterception((url) => {
  ipcRenderer.send(PRELOAD_DOC_PREVIEW_LINK_CLICK_CHANNEL, url)
})
