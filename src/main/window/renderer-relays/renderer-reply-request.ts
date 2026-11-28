import { randomUUID } from 'node:crypto'

import { ipcMain, type BrowserWindow } from 'electron'

import { addFanoutListener } from '../../runtime/events/event-listener-fanout'
import { abortWhenRendererGone } from '../../ipc/renderer-requests/renderer-lifetime-abort'

type ReplyHandler = (event: Electron.IpcMainEvent, reply: unknown) => void
const pendingRepliesByChannel = new Map<string, Map<string, ReplyHandler>>()
const releaseReplyChannel = new Map<string, () => void>()

/** One native listener per reply channel, routing each reply to its request by id. */
function routeReply(channel: string, requestId: string, handler: ReplyHandler): () => void {
  let pending = pendingRepliesByChannel.get(channel)
  if (!pending) {
    const routes = new Map<string, ReplyHandler>()
    pending = routes
    pendingRepliesByChannel.set(channel, routes)
    releaseReplyChannel.set(
      channel,
      addFanoutListener(ipcMain, channel, (event: Electron.IpcMainEvent, reply: unknown) => {
        const id =
          reply && typeof reply === 'object' && 'requestId' in reply ? reply.requestId : undefined
        if (typeof id === 'string') {
          routes.get(id)?.(event, reply)
        }
      })
    )
  }
  pending.set(requestId, handler)
  const routes = pending
  return () => {
    routes.delete(requestId)
    if (routes.size === 0 && pendingRepliesByChannel.get(channel) === routes) {
      pendingRepliesByChannel.delete(channel)
      releaseReplyChannel.get(channel)?.()
      releaseReplyChannel.delete(channel)
    }
  }
}

/** Sends one request to the window and resolves with the reply its own renderer sends; rejects when it goes away or times out. */
export function requestRendererReply<TReply extends { requestId: string }>(
  mainWindow: BrowserWindow,
  options: {
    requestChannel: string
    replyChannel: string
    payload: object
    timeoutMs: number
    timeoutError: string
    signal?: AbortSignal
    abortError?: string
  }
): Promise<TReply> {
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return Promise.reject(new Error('renderer_unavailable'))
  }
  const abortError = options.abortError ?? 'renderer_request_cancelled'
  if (options.signal?.aborted) {
    return Promise.reject(new Error(abortError))
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
    const onAbort = (): void => finish(new Error(abortError))
    const timeout = setTimeout(() => finish(new Error(options.timeoutError)), options.timeoutMs)
    const onReply: ReplyHandler = (event, reply) => {
      // Visible request IDs confer no authority; only the targeted window can answer.
      if (event.sender !== webContents) {
        return
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reply arrived on this request's own channel with its id, from its own window; callers type the reply they asked for.
      finish(null, reply as TReply)
    }
    const lifetime = abortWhenRendererGone(webContents)
    lifetime.signal.addEventListener('abort', onRendererUnavailable, { once: true })
    releaseListeners.push(
      lifetime.dispose,
      () => lifetime.signal.removeEventListener('abort', onRendererUnavailable),
      addFanoutListener(mainWindow, 'closed', onRendererUnavailable),
      routeReply(options.replyChannel, requestId, onReply)
    )
    if (options.signal) {
      const signal = options.signal
      signal.addEventListener('abort', onAbort, { once: true })
      releaseListeners.push(() => signal.removeEventListener('abort', onAbort))
    }
    try {
      webContents.send(options.requestChannel, { ...options.payload, requestId })
    } catch {
      finish(new Error('renderer_unavailable'))
    }
  })
}
