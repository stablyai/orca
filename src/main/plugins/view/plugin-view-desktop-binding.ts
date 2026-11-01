import { nativeImage, type BrowserWindow } from 'electron'
import { setPluginViewForRpc } from '../../runtime/rpc/methods/plugin-view'
import { listPluginsForClients } from '../plugin-client-list'
import type { PluginService } from '../plugin-service'
import {
  livePluginFrameGuests,
  setPluginFrameGuestLogSink
} from '../panels/plugin-frame-guest-diagnostics'
import { createPluginViewDesktop } from './plugin-view-desktop'
import { isPluginShotWindowShown } from './plugin-shot-policy'

/** Guest console lines into plugin logs, and `plugins.open` / `plugins.shot` for the desktop
 *  app; a headless serve leaves open and shot refusing. */
export function bindPluginDesktopViews(
  serveMode: boolean,
  service: PluginService,
  getMainWindow: () => BrowserWindow | null
): void {
  setPluginFrameGuestLogSink((pluginKey) => service.captureLog(pluginKey))
  if (serveMode) {
    setPluginViewForRpc(null)
    return
  }
  setPluginViewForRpc(
    createPluginViewDesktop({
      rendererContents: () => {
        const window = getMainWindow()
        return window && !window.isDestroyed() ? window.webContents : null
      },
      windowShown: () => {
        const window = getMainWindow()
        return window !== null && isPluginShotWindowShown(window)
      },
      source: {
        list: () => listPluginsForClients(service),
        findValidPlugin: (pluginKey) => service.findValidPlugin(pluginKey)
      },
      logsSince: (pluginKey, cursor) => service.getLogsSince(pluginKey, cursor),
      guestsOf: livePluginFrameGuests,
      imageFromBitmap: (bitmap, size) => nativeImage.createFromBitmap(bitmap, size)
    })
  )
}
