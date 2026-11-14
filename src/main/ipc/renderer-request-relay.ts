import { randomUUID } from 'node:crypto'
import { ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import { addFanoutListener, addFanoutListeners } from '../runtime/events/event-listener-fanout'

export const RENDERER_UNAVAILABLE = 'renderer_unavailable'

export type RendererRequestChannels<Reply extends { requestId: string }> = {
  request: string
  reply: string
  /** The reply, or null when it is not one; replies to other requests are ignored. */
  parseReply: (raw: unknown) => Reply | null
}

/** Sends one request to a window's renderer and waits for its matching reply. */
export function requestFromRenderer<Reply extends { requestId: string }>(
  webContents: WebContents,
  channels: RendererRequestChannels<Reply>,
  body: object,
  timeoutMs: number
): Promise<Reply> {
  if (webContents.isDestroyed()) {
    return Promise.reject(new Error(RENDERER_UNAVAILABLE))
  }
  const requestId = randomUUID()
  return new Promise<Reply>((resolve, reject) => {
    const releases: (() => void)[] = []
    let settled = false
    const finish = (outcome: { reply: Reply } | { error: Error }): void => {
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
      const reply = channels.parseReply(raw)
      if (reply?.requestId === requestId) {
        finish({ reply })
      }
    }
    const onGone = (): void => finish({ error: new Error(RENDERER_UNAVAILABLE) })
    releases.push(
      addFanoutListener(ipcMain, channels.reply, onReply),
      addFanoutListeners(webContents, ['destroyed', 'render-process-gone'], onGone)
    )
    try {
      webContents.send(channels.request, { ...body, requestId })
    } catch {
      onGone()
    }
  })
}
