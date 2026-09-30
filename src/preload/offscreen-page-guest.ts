import type { IpcRenderer } from 'electron'
import type { OffscreenPageGuestChannels } from '../shared/offscreen-page-guest-channels'
import { answerDatalistQueries } from './offscreen-page-datalist'
import { installTooltipReporter } from './offscreen-page-tooltip'

// Why not imported: a sandboxed preload cannot load a chunk shared with main, so the one name it
// needs up front is repeated here (a test pins it to main's); main replies with the rest.
export const GUEST_KIND_CHANNEL = 'offscreen-page:is-offscreen'

/**
 * Reports what an offscreen page's frame shows outside its pixels (tooltips, datalist rows).
 * Runs in the preload's isolated world, where the page cannot see or reach ipcRenderer. A
 * <webview> page shares this preload but shows these natively, so main answers null for it.
 */
export function installOffscreenPageGuest(ipc: IpcRenderer): void {
  void ipc
    .invoke(GUEST_KIND_CHANNEL)
    .then((channels: OffscreenPageGuestChannels | null) => {
      if (!channels) {
        return
      }
      installTooltipReporter((text) => ipc.send(channels.tooltip, text))
      answerDatalistQueries(
        (answer) => ipc.on(channels.datalistQuery, answer),
        (items) => ipc.send(channels.datalistItems, items)
      )
    })
    .catch(() => {})
}
