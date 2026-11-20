import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron'
import type {
  RendererReply,
  RendererRequest,
  RuntimeDesktopSurface
} from '../runtime/construction/runtime-desktop-surface'
import { rendererPublicationThrottle } from '../window/visibility/renderer-publication-throttle'

function liveRenderer(windowId: number): Electron.WebContents | null {
  const window = BrowserWindow.fromId(windowId)
  return window && !window.isDestroyed() && !window.webContents.isDestroyed?.()
    ? window.webContents
    : null
}

const requestRenderer = <T extends RendererReply>(
  windowId: number,
  request: RendererRequest
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const renderer = liveRenderer(windowId)
    if (!renderer) {
      reject(new Error('runtime_unavailable'))
      return
    }
    if (request.signal?.aborted) {
      reject(new Error(request.abortMessage ?? 'Renderer request was cancelled'))
      return
    }
    const settle = (): void => {
      clearTimeout(timer)
      ipcMain.removeListener(request.replyChannel, onReply)
      request.signal?.removeEventListener('abort', onAbort)
    }
    const timer = setTimeout(() => {
      settle()
      reject(new Error(request.timeoutMessage))
    }, request.timeoutMs)
    const onAbort = (): void => {
      settle()
      reject(new Error(request.abortMessage ?? 'Renderer request was cancelled'))
    }
    const onReply = (event: IpcMainEvent, reply: T | undefined): void => {
      if (event.sender !== renderer || reply?.requestId !== request.requestId) {
        return
      }
      settle()
      resolve(reply)
    }
    request.signal?.addEventListener('abort', onAbort, { once: true })
    ipcMain.on(request.replyChannel, onReply)
    renderer.send(request.channel, request.payload)
  })

/** Window-addressed renderer access the runtime reaches through RuntimeDesktopSurface. */
export const electronRendererWindows: Pick<
  RuntimeDesktopSurface,
  | 'hasWindow'
  | 'hasLiveRenderer'
  | 'sendToWindow'
  | 'requestRenderer'
  | 'holdRendererPublication'
  | 'rendererIdOfWindow'
> = {
  hasWindow: (windowId) => {
    const window = BrowserWindow.fromId(windowId)
    return !!window && !window.isDestroyed()
  },
  hasLiveRenderer: (windowId) => liveRenderer(windowId) !== null,
  sendToWindow: (windowId, channel, payload) => {
    const renderer = liveRenderer(windowId)
    if (!renderer) {
      return false
    }
    renderer.send(channel, payload)
    return true
  },
  requestRenderer,
  holdRendererPublication: (windowId) => {
    const renderer = liveRenderer(windowId)
    return renderer ? rendererPublicationThrottle.acquire(renderer) : () => {}
  },
  rendererIdOfWindow: (windowId) => liveRenderer(windowId)?.id ?? null
}
