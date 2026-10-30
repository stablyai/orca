import { addFanoutListeners, type FanoutEventSource } from '../event-listener-fanout'

export type RendererLifetimeSender = FanoutEventSource

export const RENDERER_GONE_MESSAGE = 'The window that started this upload went away'

// Abort only committed document replacement; blocked external links and same-document navigation preserve the caller.
const RENDERER_GONE_EVENTS = ['destroyed', 'render-process-gone', 'did-navigate'] as const

/** Bind main-process work to its requesting renderer; dispose in finally to release WebContents listeners. */
export function abortWhenRendererGone(sender: RendererLifetimeSender): {
  signal: AbortSignal
  dispose: () => void
} {
  const controller = new AbortController()
  // Shared fan-out: concurrent lifetimes on one renderer add one native listener per event, not one each.
  const dispose = addFanoutListeners(sender, RENDERER_GONE_EVENTS, () => {
    dispose()
    controller.abort(new Error(RENDERER_GONE_MESSAGE))
  })
  return { signal: controller.signal, dispose }
}
