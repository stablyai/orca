import { randomUUID } from 'node:crypto'
import { ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import { addFanoutListener, addFanoutListeners } from '../../event-listener-fanout'
import {
  PLUGIN_VIEW_REPLY_CHANNEL,
  PLUGIN_VIEW_REQUEST_CHANNEL,
  type PluginViewReply,
  type PluginViewRequestBody
} from '../../../shared/plugins/view/plugin-view-protocol'
import { pluginViewReplySchema } from './plugin-view-reply-schema'

export const PLUGIN_VIEW_RENDERER_UNAVAILABLE = 'renderer_unavailable'

/** Sends one view request to the window's renderer and waits for its matching reply. */
export function requestPluginViewFromRenderer(
  webContents: WebContents,
  body: PluginViewRequestBody,
  timeoutMs: number
): Promise<PluginViewReply> {
  if (webContents.isDestroyed()) {
    return Promise.reject(new Error(PLUGIN_VIEW_RENDERER_UNAVAILABLE))
  }
  const requestId = randomUUID()
  return new Promise<PluginViewReply>((resolve, reject) => {
    const releases: (() => void)[] = []
    let settled = false
    const finish = (outcome: { reply: PluginViewReply } | { error: Error }): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      for (const release of releases) {
        release()
      }
      if ('reply' in outcome) {
        resolve(outcome.reply)
      } else {
        reject(outcome.error)
      }
    }
    const timer = setTimeout(
      () =>
        finish({ error: new Error('Orca did not answer in time; is its window still loading?') }),
      timeoutMs
    )
    timer.unref?.()
    const onReply = (event: IpcMainEvent, raw: unknown): void => {
      if (event.sender !== webContents) {
        return
      }
      const parsed = pluginViewReplySchema.safeParse(raw)
      if (parsed.success && parsed.data.requestId === requestId) {
        finish({ reply: parsed.data })
      }
    }
    const onGone = (): void => finish({ error: new Error(PLUGIN_VIEW_RENDERER_UNAVAILABLE) })
    releases.push(
      addFanoutListener(ipcMain, PLUGIN_VIEW_REPLY_CHANNEL, onReply),
      addFanoutListeners(webContents, ['destroyed', 'render-process-gone'], onGone)
    )
    try {
      webContents.send(PLUGIN_VIEW_REQUEST_CHANNEL, { ...body, requestId })
    } catch {
      onGone()
    }
  })
}
