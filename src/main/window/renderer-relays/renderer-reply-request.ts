import { randomUUID } from 'node:crypto'

import { ipcMain, type BrowserWindow } from 'electron'

import { addFanoutListener } from '../../runtime/events/event-listener-fanout'
import { abortWhenRendererGone } from '../../ipc/renderer-lifetime-abort'

/** Sends one request to the window and resolves with the reply its own renderer sends; rejects when it goes away or times out. */
export function requestRendererReply<TReply extends { requestId: string }>(
  mainWindow: BrowserWindow,
  options: {
    requestChannel: string
    replyChannel: string
    payload: object
    timeoutMs: number
    timeoutError: string
  }
): Promise<TReply> {
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return Promise.reject(new Error('renderer_unavailable'))
  }
  const webContents = mainWindow.webContents
  const requestId = randomUUID()
  return new Promise<TReply>((resolve, reject) => {
    let settled = false
    const releaseListeners: (() => void)[] = []
    const finish = (error: Error | null, reply?: TReply): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      for (const release of releaseListeners) {
        release()
      }
      if (reply) {
        resolve(reply)
      } else {
        reject(error)
      }
    }
    const onRendererUnavailable = (): void => finish(new Error('renderer_unavailable'))
    const timeout = setTimeout(() => finish(new Error(options.timeoutError)), options.timeoutMs)
    const onReply = (event: Electron.IpcMainEvent, reply: TReply): void => {
      // Visible request IDs confer no authority; only the targeted window can answer.
      if (event.sender !== webContents || reply?.requestId !== requestId) {
        return
      }
      finish(null, reply)
    }
    const lifetime = abortWhenRendererGone(webContents)
    lifetime.signal.addEventListener('abort', onRendererUnavailable, { once: true })
    releaseListeners.push(
      lifetime.dispose,
      () => lifetime.signal.removeEventListener('abort', onRendererUnavailable),
      addFanoutListener(mainWindow, 'closed', onRendererUnavailable),
      addFanoutListener(ipcMain, options.replyChannel, onReply)
    )
    try {
      webContents.send(options.requestChannel, { ...options.payload, requestId })
    } catch {
      finish(new Error('renderer_unavailable'))
    }
  })
}
