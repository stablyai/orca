import type { BrowserWindow } from 'electron'
import { setPluginViewForRpc } from '../../runtime/rpc/methods/plugin-view'
import { listPluginsForClients } from '../plugin-client-list'
import type { PluginService } from '../plugin-service'
import { livePluginFrameGuests } from '../panels/plugin-frame-guest-diagnostics'
import { createPluginViewDesktop } from './plugin-view-desktop'
import { isPluginShotWindowShown } from './plugin-shot-policy'

/** `plugins.open` / `plugins.shot` for the desktop app; a headless serve leaves them refusing. */
export function bindPluginViewForRpc(options: {
  serveMode: boolean
  service: PluginService
  getMainWindow: () => BrowserWindow | null
}): void {
  if (options.serveMode) {
    setPluginViewForRpc(null)
    return
  }
  const { service } = options
  setPluginViewForRpc(
    createPluginViewDesktop({
      rendererContents: () => {
        const window = options.getMainWindow()
        return window && !window.isDestroyed() ? window.webContents : null
      },
      windowShown: () => {
        const window = options.getMainWindow()
        return window !== null && isPluginShotWindowShown(window)
      },
      source: {
        list: () => listPluginsForClients(service),
        findValidPlugin: (pluginKey) => service.findValidPlugin(pluginKey)
      },
      logsSince: (pluginKey, cursor) => service.getLogsSince(pluginKey, cursor),
      guestsOf: livePluginFrameGuests
    })
  )
}
