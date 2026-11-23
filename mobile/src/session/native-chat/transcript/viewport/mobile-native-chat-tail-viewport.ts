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

/** `startsAtTop`: a scroller that opens at its top and may never scroll knows its place from its
 *  sizes alone; a chat list instead opens at its end and reports it by scrolling there. */
export function createMobileNativeChatTailViewport(
  startsAtTop = false
): MobileNativeChatTailViewport {
  let metrics: { offset: number; content: number; height: number } | null = null
  // Sizes seen before the first scroll, for a scroller that starts at its top.
  let content: number | null = null
  let height: number | null = null
  const fromSizes = (): void => {
    if (startsAtTop && !metrics && content !== null && height !== null) {
      metrics = { offset: 0, content, height }
    }
  }
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
    contentResized: (next) => {
      content = next
      fromSizes()
      if (metrics) {
        metrics = { ...metrics, content: next }
        publish()
      }
    },
    laidOut: (next) => {
      height = next
      fromSizes()
      if (metrics) {
        metrics = { ...metrics, height: next }
        publish()
      }
    },
    reset: () => {
      metrics = null
      content = null
      height = null
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
