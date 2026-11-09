import { webContents } from 'electron'
import type { PRRefreshRendererPort } from '../github/pr-refresh-renderer-port'
import { sendToTrustedUIRenderer } from '../ipc/ui'

export const electronPRRefreshRenderer: PRRefreshRendererPort = {
  isRendererOpen: (webContentsId) => {
    const contents = webContents.fromId(webContentsId)
    return contents !== undefined && !contents.isDestroyed()
  },
  sendToTrustedUI: (channel, payload) => sendToTrustedUIRenderer(channel, payload)
}
