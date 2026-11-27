import { useEffect, useRef, useState } from 'react'
import {
  isLeftwardSwipe,
  SIDEBAR_SWIPE_EVENT,
  SIDEBAR_SWIPE_OWNER_ATTRIBUTE,
  type SidebarSwipeDetail
} from '../../terminal/document/surface-input/sidebar-swipe-handoff'
import type { SidebarPageDrag } from './sidebar-page-drag'

// The release speed is read over the last stretch of the drag, not its whole length.
const VELOCITY_WINDOW_MS = 100

function isTextEntry(element: Element): boolean {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    (element instanceof HTMLElement && element.isContentEditable)
  )
}

// A text field, anything that scrolls sideways itself (code blocks, tables, wide diffs), or a
// terminal (which hands its own swipes over) keeps its drags.
function keepsItsDrags(target: Element, root: HTMLElement): boolean {
  for (let node: Element | null = target; node && node !== root; node = node.parentElement) {
    if (isTextEntry(node) || node.hasAttribute(SIDEBAR_SWIPE_OWNER_ATTRIBUTE)) {
      return true
    }
    if (node.scrollWidth > node.clientWidth + 1) {
      const overflowX = getComputedStyle(node).overflowX
      if (overflowX === 'auto' || overflowX === 'scroll') {
        return true
      }
    }
  }
  return false
}

const selecting = () => {
  const selection = window.getSelection()
  return selection !== null && !selection.isCollapsed
}

/** One swipe at a time: where it began, whether it's claimed, and its recent path for the release speed. */
function createSwipeTracker(drag: () => SidebarPageDrag | null) {
  let start: { x: number; y: number } | null = null
  let claimed = false
  let samples: { x: number; at: number }[] = []
  return {
    begin(x: number, y: number, at: number) {
      start = { x, y }
      claimed = false
      samples = [{ x, at }]
    },
    tracking: () => start !== null,
    /** Returns true when the swipe owns this move (the caller stops the page scrolling). */
    move(x: number, y: number, at: number, cancelable: boolean): boolean {
      if (!start) {
        return false
      }
      if (!claimed) {
        const leftward = isLeftwardSwipe(x - start.x, y - start.y)
        if (leftward === null) {
          return false
        }
        // Rightward, vertical, or already scrolling: not ours for the rest of this touch.
        if (!leftward || !cancelable) {
          start = null
          return false
        }
        claimed = true
        drag()?.begin()
      }
      drag()?.follow(x - start.x)
      samples.push({ x, at })
      samples = samples.filter((sample) => at - sample.at <= VELOCITY_WINDOW_MS)
      return true
    },
    finish(success: boolean) {
      if (claimed) {
        const first = samples[0]
        const last = samples.at(-1)
        const elapsed = first && last ? last.at - first.at : 0
        const velocity = first && last && elapsed > 0 ? ((last.x - first.x) / elapsed) * 1000 : 0
        drag()?.end(velocity, success)
      }
      start = null
      claimed = false
    }
  }
}

/**
 * A leftward swipe across the page's content (a chat's transcript, a note) opens the tabs sidebar,
 * tracking the finger 1:1 through the same phases as the top bar's drag. It decides only after
 * the slop of mostly sideways travel, so vertical scrolling never waits on it, and it leaves
 * drags that start in a text field, in something that scrolls sideways, or over a selection alone.
 * A terminal decides its own touches and hands a swipe over as SIDEBAR_SWIPE_EVENT phases.
 */
export function useSidebarContentSwipe(
  drag: SidebarPageDrag | null,
  enabled: boolean
): (node: unknown) => void {
  const latest = useRef(drag)
  useEffect(() => {
    latest.current = drag
  })
  const [node, setNode] = useState<HTMLElement | null>(null)
  const live = enabled && drag !== null
  useEffect(() => {
    if (!node || !live) {
      return
    }
    const swipe = createSwipeTracker(() => latest.current)
    let touchId: number | null = null
    const onStart = (event: TouchEvent) => {
      swipe.finish(false)
      touchId = null
      const touch = event.touches[0]
      const target = event.target instanceof Element ? event.target : null
      if (event.touches.length !== 1 || !touch || !target) {
        return
      }
      if (keepsItsDrags(target, node) || selecting()) {
        return
      }
      touchId = touch.identifier
      swipe.begin(touch.clientX, touch.clientY, event.timeStamp)
    }
    const onMove = (event: TouchEvent) => {
      const touch = Array.from(event.touches).find((each) => each.identifier === touchId)
      if (touch && swipe.move(touch.clientX, touch.clientY, event.timeStamp, event.cancelable)) {
        event.preventDefault()
      }
    }
    const onEnd = () => swipe.finish(true)
    const onCancel = () => swipe.finish(false)
    // The terminal already decided its swipe is leftward and sideways; each move is the page's.
    const onHandoff = (event: Event) => {
      if (!(event instanceof CustomEvent)) {
        return
      }
      // The terminal document is this event's only sender (sidebar-swipe-handoff.ts).
      const detail: SidebarSwipeDetail = event.detail
      if (detail.phase === 'start') {
        swipe.begin(detail.x, detail.y, detail.at)
      } else if (detail.phase === 'move') {
        swipe.move(detail.x, detail.y, detail.at, true)
      } else {
        swipe.finish(detail.phase === 'end')
      }
    }
    node.addEventListener('touchstart', onStart, { passive: true })
    // Not passive: a claimed swipe stops the page scrolling under it.
    node.addEventListener('touchmove', onMove, { passive: false })
    node.addEventListener('touchend', onEnd, { passive: true })
    node.addEventListener('touchcancel', onCancel, { passive: true })
    node.addEventListener(SIDEBAR_SWIPE_EVENT, onHandoff)
    return () => {
      swipe.finish(false)
      node.removeEventListener('touchstart', onStart)
      node.removeEventListener('touchmove', onMove)
      node.removeEventListener('touchend', onEnd)
      node.removeEventListener('touchcancel', onCancel)
      node.removeEventListener(SIDEBAR_SWIPE_EVENT, onHandoff)
    }
  }, [node, live])
  return (next: unknown) => setNode(next instanceof HTMLElement ? next : null)
}
