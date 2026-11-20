import { BrowserWindow } from 'electron'
import { requestRendererReply } from '../window/renderer-relays/renderer-reply-request'
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
): Promise<T> => {
  const window = BrowserWindow.fromId(windowId)
  return window
    ? requestRendererReply<T>(window, {
        requestChannel: request.channel,
        replyChannel: request.replyChannel,
        payload: request.payload,
        timeoutMs: request.timeoutMs,
        timeoutError: request.timeoutMessage,
        signal: request.signal,
        abortError: request.abortMessage
      })
    : Promise.reject(new Error('renderer_unavailable'))
}

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
