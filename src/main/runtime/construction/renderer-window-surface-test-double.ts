import { randomUUID } from 'node:crypto'
import type { RuntimeDesktopSurface } from './runtime-desktop-surface'

export const TEST_RENDERER_WINDOW_ID = 1

type FakeRenderer = {
  id?: number
  send(channel: string, payload: unknown): void
  isDestroyed?(): boolean
}
type FakeWindow = { isDestroyed?(): boolean; webContents: FakeRenderer }
type ReplyListener = (event: { sender: unknown }, reply: unknown) => void
type FakeReplies = {
  on(channel: string, listener: ReplyListener): unknown
  removeListener(channel: string, listener: ReplyListener): unknown
}

/** Renderer windows for runtime tests: one fixed renderer, or a lookup over the test's window doubles. Replies arrive through the test's own IPC double. */
export function rendererWindowSurfaceForTest(
  target: FakeRenderer | ((windowId: number) => FakeWindow | null | undefined),
  replies?: FakeReplies
): RuntimeDesktopSurface {
  const windowOf = (windowId: number): FakeWindow | null =>
    typeof target === 'function'
      ? (target(windowId) ?? null)
      : windowId === TEST_RENDERER_WINDOW_ID
        ? { webContents: target }
        : null
  const openWindow = (windowId: number): FakeWindow | null => {
    const window = windowOf(windowId)
    return window && !window.isDestroyed?.() ? window : null
  }
  const liveRenderer = (windowId: number): FakeRenderer | null => {
    const renderer = openWindow(windowId)?.webContents
    return renderer && !renderer.isDestroyed?.() ? renderer : null
  }
  return {
    showNotification: () => false,
    hasWindow: (windowId) => openWindow(windowId) !== null,
    hasLiveRenderer: (windowId) => liveRenderer(windowId) !== null,
    sendToWindow: (windowId, channel, payload) => {
      const renderer = liveRenderer(windowId)
      renderer?.send(channel, payload)
      return renderer !== null
    },
    requestRenderer: (windowId, request) =>
      new Promise((resolve, reject) => {
        const renderer = liveRenderer(windowId)
        if (!renderer || !replies) {
          reject(new Error('renderer_unavailable'))
          return
        }
        const abortError = request.abortMessage ?? 'renderer_request_cancelled'
        if (request.signal?.aborted) {
          reject(new Error(abortError))
          return
        }
        const requestId = randomUUID()
        const settle = (): void => {
          clearTimeout(timer)
          replies.removeListener(request.replyChannel, onReply)
          request.signal?.removeEventListener('abort', onAbort)
        }
        const timer = setTimeout(() => {
          settle()
          reject(new Error(request.timeoutMessage))
        }, request.timeoutMs)
        const onAbort = (): void => {
          settle()
          reject(new Error(abortError))
        }
        const onReply = (event: { sender: unknown }, reply: unknown): void => {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test replies are plain objects; only the echoed id is read.
          const replyId = (reply as { requestId?: unknown } | undefined)?.requestId
          if (event.sender !== renderer || replyId !== requestId) {
            return
          }
          settle()
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the caller names the reply shape its renderer double sends.
          resolve(reply as never)
        }
        request.signal?.addEventListener('abort', onAbort, { once: true })
        replies.on(request.replyChannel, onReply)
        renderer.send(request.channel, { ...request.payload, requestId })
      }),
    holdRendererPublication: () => () => {},
    rendererIdOfWindow: (windowId) => {
      const renderer = liveRenderer(windowId)
      return renderer ? (renderer.id ?? 1) : null
    }
  }
}
