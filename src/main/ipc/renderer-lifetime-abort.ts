import type { WebContents } from 'electron'

export type RendererLifetimeSender = Pick<WebContents, 'once' | 'removeListener'>

export const RENDERER_GONE_MESSAGE = 'The window that started this upload went away'

/**
 * Abort signal that fires when the calling renderer goes away.
 *
 * Work the renderer used to do itself died with it. Once it moves into main,
 * nothing stops a long transfer from outliving the window that asked for it,
 * so the caller's lifetime has to be wired up explicitly.
 *
 * Always `dispose()` in a finally — otherwise every call leaks a listener on a
 * long-lived WebContents.
 */
export function abortWhenRendererGone(sender: RendererLifetimeSender): {
  signal: AbortSignal
  dispose: () => void
} {
  const controller = new AbortController()
  const abort = (): void => controller.abort(new Error(RENDERER_GONE_MESSAGE))
  let disposed = false

  sender.once('destroyed', abort)
  sender.once('render-process-gone', abort)
  // Why: did-start-navigation also fires for navigations that will-navigate then
  // blocks — an external link, a stray file drop — and the renderer survives
  // those. did-navigate fires only once a new document has replaced the caller,
  // and never for same-document route changes inside the live app.
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
