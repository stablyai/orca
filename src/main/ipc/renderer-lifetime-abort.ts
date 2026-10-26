import type { WebContents } from 'electron'

export type RendererLifetimeSender = Pick<WebContents, 'once' | 'removeListener'>

export const RENDERER_GONE_MESSAGE = 'The window that started this upload went away'

/** Bind main-process work to its requesting renderer; dispose in finally to release WebContents listeners. */
export function abortWhenRendererGone(sender: RendererLifetimeSender): {
  signal: AbortSignal
  dispose: () => void
} {
  const controller = new AbortController()
  const abort = (): void => controller.abort(new Error(RENDERER_GONE_MESSAGE))
  let disposed = false

  sender.once('destroyed', abort)
  sender.once('render-process-gone', abort)
  // Abort only committed document replacement; blocked external links and same-document navigation preserve the caller.
  sender.once('did-navigate', abort)

  return {
    signal: controller.signal,
    dispose: () => {
      if (disposed) {
        return
      }
      disposed = true
      sender.removeListener('destroyed', abort)
      sender.removeListener('render-process-gone', abort)
      sender.removeListener('did-navigate', abort)
    }
  }
}
