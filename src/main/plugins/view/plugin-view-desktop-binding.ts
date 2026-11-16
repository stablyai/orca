import { app, nativeImage, type BrowserWindow } from 'electron'
import { setPluginViewForRpc } from '../../runtime/rpc/methods/plugins/plugin-view'
import { listPluginsForClients } from '../discovery/plugin-client-list'
import type { PluginService } from '../plugin-service'
import {
  livePluginFrameGuests,
  setPluginFrameGuestLogSink
} from '../panels/guest-isolation/plugin-frame-guest-diagnostics'
import { createPluginViewDesktop } from './plugin-view-desktop'
import { isPluginShotWindowShown } from './plugin-shot-policy'
import {
  setPluginHostRendererRequest,
  setPluginHostWindowRaise
} from './plugin-host-renderer-actions'
import { requestPluginViewFromRenderer } from './plugin-view-renderer-relay'
import { focusExistingMainWindow } from '../../window/activation/focus-existing-window'

const HOST_ACTION_TIMEOUT_MS = 10_000

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
    setPluginHostRendererRequest(null)
    setPluginHostWindowRaise(null)
    return
  }
  // The one main window, so a worker's editor.open and commands.run always reach the same one.
  setPluginHostRendererRequest((body) => {
    const window = getMainWindow()
    return window && !window.isDestroyed()
      ? requestPluginViewFromRenderer(window.webContents, body, HOST_ACTION_TIMEOUT_MS)
      : null
  })
  setPluginHostWindowRaise(() => {
    const window = getMainWindow()
    if (window && !window.isDestroyed()) {
      focusExistingMainWindow({
        app,
        getWindow: () => window,
        // Raise only the window that showed it; never construct a replacement.
        canOpenWindow: () => false,
        openWindow: () => window
      })
    }
  })
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
      imageFromBitmap: (bitmap, size) => nativeImage.createFromBitmap(bitmap, size),
      shotScratchRoot: () => app.getPath('temp')
    })
  )
}
