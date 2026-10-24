import type { BrowserHistoryWheel } from '../shared/browser-history-gesture'

function pageOwnsHorizontalScroll(event: WheelEvent): boolean {
  for (const target of event.composedPath()) {
    if (!(target instanceof Element)) {
      continue
    }
    const style = getComputedStyle(target)
    if (style.overscrollBehaviorX === 'contain' || style.overscrollBehaviorX === 'none') {
      return true
    }
    if (
      target.scrollWidth > target.clientWidth + 1 &&
      (target === document.scrollingElement || /^(auto|scroll|overlay)$/.test(style.overflowX))
    ) {
      return true
    }
  }
  return false
}

export function installBrowserHistoryWheel(
  subscribe: (callback: (gestureId: number | null) => void) => () => void,
  report: (wheel: BrowserHistoryWheel) => void
): () => void {
  let activeId: number | null = null
  let disposed = false
  const unsubscribe = subscribe((gestureId) => {
    activeId = gestureId
  })
  const onWheel = (event: WheelEvent): void => {
    const gestureId = activeId
    if (gestureId === null || !event.isTrusted) {
      return
    }
    const blocked =
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey ||
      event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL ||
      pageOwnsHorizontalScroll(event)
    const { deltaX, deltaY } = event
    // Wait for page listeners to finish cancelling the event before reporting it.
    window.setTimeout(() => {
      if (!disposed && activeId === gestureId) {
        report({ gestureId, deltaX, deltaY, blocked: blocked || event.defaultPrevented })
      }
    }, 0)
  }
  window.addEventListener('wheel', onWheel, { passive: true })
  return () => {
    disposed = true
    unsubscribe()
    window.removeEventListener('wheel', onWheel)
  }
}
