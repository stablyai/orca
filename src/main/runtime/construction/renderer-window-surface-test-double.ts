import type { RuntimeDesktopSurface } from './runtime-desktop-surface'

export const TEST_RENDERER_WINDOW_ID = 1

type FakeRenderer = {
  id?: number
  send(channel: string, payload: unknown): void
  isDestroyed?(): boolean
}
type ReplyListener = (event: { sender: unknown }, reply: unknown) => void
type FakeReplies = {
  on(channel: string, listener: ReplyListener): unknown
  removeListener(channel: string, listener: ReplyListener): unknown
}

/** One renderer window for runtime tests; replies arrive through the test's own IPC double. */
export function rendererWindowSurfaceForTest(
  renderer: FakeRenderer,
  replies?: FakeReplies
): RuntimeDesktopSurface {
  const live = (windowId: number): boolean =>
    windowId === TEST_RENDERER_WINDOW_ID && !renderer.isDestroyed?.()
  return {
    showNotification: () => false,
    hasWindow: (windowId) => windowId === TEST_RENDERER_WINDOW_ID,
    hasLiveRenderer: live,
    sendToWindow: (windowId, channel, payload) => {
      if (!live(windowId)) {
        return false
      }
      renderer.send(channel, payload)
      return true
    },
    requestRenderer: (windowId, request) =>
      new Promise((resolve, reject) => {
        if (!live(windowId) || !replies) {
          reject(new Error('runtime_unavailable'))
          return
        }
        const timer = setTimeout(() => {
          replies.removeListener(request.replyChannel, onReply)
          reject(new Error(request.timeoutMessage))
        }, request.timeoutMs)
        const onReply = (event: { sender: unknown }, reply: unknown): void => {
          const requestId = (reply as { requestId?: unknown } | undefined)?.requestId
          if (event.sender !== renderer || requestId !== request.requestId) {
            return
          }
          clearTimeout(timer)
          replies.removeListener(request.replyChannel, onReply)
          resolve(reply as never)
        }
        replies.on(request.replyChannel, onReply)
        renderer.send(request.channel, request.payload)
      }),
    holdRendererPublication: () => () => {},
    rendererIdOfWindow: (windowId) => (live(windowId) ? (renderer.id ?? 1) : null)
  }
}
