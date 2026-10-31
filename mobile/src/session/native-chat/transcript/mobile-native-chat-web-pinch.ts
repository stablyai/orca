type Touches = { length: number; [index: number]: { clientX: number; clientY: number } }

function spread(touches: Touches): number {
  const a = touches[0]
  const b = touches[1]
  return Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY))
}

/**
 * In the WebView the browser takes a two-finger pinch as page zoom, which gesture-handler never
 * sees. Claims it on `node` instead and reports the fingers' spread relative to where they started.
 */
export function attachWebChatPinch(
  node: HTMLElement,
  pinch: { begin: () => void; change: (ratio: number) => void }
): () => void {
  let start: number | null = null
  const onTouchStart = (event: TouchEvent): void => {
    if (event.touches.length === 2) {
      start = spread(event.touches)
      pinch.begin()
    }
  }
  const onTouchMove = (event: TouchEvent): void => {
    if (start === null || event.touches.length !== 2) {
      return
    }
    event.preventDefault()
    pinch.change(spread(event.touches) / start)
  }
  const onTouchEnd = (event: TouchEvent): void => {
    if (event.touches.length < 2) {
      start = null
    }
  }
  // WebKit's own pinch events zoom the page unless cancelled.
  const onGesture = (event: Event): void => event.preventDefault()
  const options = { capture: true, passive: false } as const
  node.addEventListener('touchstart', onTouchStart, options)
  node.addEventListener('touchmove', onTouchMove, options)
  node.addEventListener('touchend', onTouchEnd, options)
  node.addEventListener('touchcancel', onTouchEnd, options)
  node.addEventListener('gesturestart', onGesture, options)
  node.addEventListener('gesturechange', onGesture, options)
  return () => {
    node.removeEventListener('touchstart', onTouchStart, options)
    node.removeEventListener('touchmove', onTouchMove, options)
    node.removeEventListener('touchend', onTouchEnd, options)
    node.removeEventListener('touchcancel', onTouchEnd, options)
    node.removeEventListener('gesturestart', onGesture, options)
    node.removeEventListener('gesturechange', onGesture, options)
  }
}
