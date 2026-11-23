import type { MobileScrollTailMetrics } from './use-mobile-native-chat-tail-follow'

/** What part of a list's end is on screen: how far the view's bottom sits above the content's end,
 *  and the view's height. Null until the list first scrolls. */
export type MobileNativeChatTailWindow = { fromEnd: number; height: number }

/** The list's view of its own end, for rows drawn after the transcript (its footer) that are not
 *  windowed with it and must know when they are off screen. Content growth and a resized view move
 *  that end without a scroll, so each is recorded from its own event. */
export type MobileNativeChatTailViewport = {
  record: (metrics: MobileScrollTailMetrics) => void
  contentResized: (height: number) => void
  laidOut: (height: number) => void
  /** A different chat: nothing is known until it scrolls. */
  reset: () => void
  read: () => MobileNativeChatTailWindow | null
  subscribe: (listener: () => void) => () => void
}

// Moves smaller than this redraw nothing: callers only ask whether a row is in view.
const STEP_PX = 24

export function createMobileNativeChatTailViewport(): MobileNativeChatTailViewport {
  let metrics: { offset: number; content: number; height: number } | null = null
  let current: MobileNativeChatTailWindow | null = null
  const listeners = new Set<() => void>()
  const publish = (): void => {
    const next = metrics && {
      fromEnd: Math.max(0, metrics.content - (metrics.offset + metrics.height)),
      height: metrics.height
    }
    if (
      next &&
      current &&
      Math.abs(next.fromEnd - current.fromEnd) < STEP_PX &&
      Math.abs(next.height - current.height) < STEP_PX
    ) {
      return
    }
    if (next === current) {
      return
    }
    current = next
    listeners.forEach((notify) => notify())
  }
  return {
    record: ({ contentOffset, contentSize, layoutMeasurement }) => {
      metrics = {
        offset: contentOffset.y,
        content: contentSize.height,
        height: layoutMeasurement.height
      }
      publish()
    },
    contentResized: (height) => {
      if (metrics) {
        metrics = { ...metrics, content: height }
        publish()
      }
    },
    laidOut: (height) => {
      if (metrics) {
        metrics = { ...metrics, height }
        publish()
      }
    },
    reset: () => {
      metrics = null
      publish()
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
