import {
  installDocPreviewLinkInterception,
  PRELOAD_DOC_PREVIEW_LINK_CLICK_CHANNEL
} from './doc-preview-link-interception'

// Why: raw require keeps the sandboxed preload standalone in the main-process CJS build.
const { ipcRenderer } = require('electron') as {
  ipcRenderer: { send: (channel: string, ...args: unknown[]) => void }
}

// Why no contextBridge: the document must not be able to call this. The listeners live in the
// isolated world, and main still refuses any report that does not come from a live, grant-bound preview guest.
installDocPreviewLinkInterception((url) => {
  ipcRenderer.send(PRELOAD_DOC_PREVIEW_LINK_CLICK_CHANNEL, url)
})
