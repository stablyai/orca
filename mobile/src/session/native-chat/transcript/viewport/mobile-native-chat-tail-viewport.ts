import type { MobileScrollTailMetrics } from './use-mobile-native-chat-tail-follow'

/** What part of a list's end is on screen: how far the view's bottom sits above the content's end,
 *  and the view's height. Null until the list first scrolls or lays out. */
export type MobileNativeChatTailWindow = { fromEnd: number; height: number }

/** The list's view of its own end, for rows drawn after the transcript (its footer) that are not
 *  windowed with it and must know when they are off screen. */
export type MobileNativeChatTailViewport = {
  record: (metrics: MobileScrollTailMetrics) => void
  read: () => MobileNativeChatTailWindow | null
  subscribe: (listener: () => void) => () => void
}

// Moves smaller than this redraw nothing: callers only ask whether a row is in view.
const STEP_PX = 24

export function createMobileNativeChatTailViewport(): MobileNativeChatTailViewport {
  let current: MobileNativeChatTailWindow | null = null
  const listeners = new Set<() => void>()
  return {
    record: ({ contentOffset, contentSize, layoutMeasurement }) => {
      const next = {
        fromEnd: Math.max(0, contentSize.height - (contentOffset.y + layoutMeasurement.height)),
        height: layoutMeasurement.height
      }
      if (
        current &&
        Math.abs(next.fromEnd - current.fromEnd) < STEP_PX &&
        Math.abs(next.height - current.height) < STEP_PX
      ) {
        return
      }
      current = next
      listeners.forEach((notify) => notify())
    },
    read: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
