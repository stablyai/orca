import { useEffect, useRef, useState } from 'react'
import type { SidebarPageDrag } from './sidebar-page-drag'

// A swipe claims the touch only once it has moved this far, mostly sideways and leftward.
const SLOP = 10
const HORIZONTAL_DOMINANCE = 1.5
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

// A text field, or anything that scrolls sideways itself (code blocks, tables, wide diffs), keeps its drags.
function keepsItsDrags(target: Element, root: HTMLElement): boolean {
  for (let node: Element | null = target; node && node !== root; node = node.parentElement) {
    if (isTextEntry(node)) {
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

/**
 * A leftward swipe across the page's content (a chat's transcript, a note) opens the tabs sidebar,
 * tracking the finger 1:1 through the same phases as the top bar's drag. It decides only after
 * SLOP points of mostly sideways travel, so vertical scrolling never waits on it, and it leaves
 * drags that start in a text field, in something that scrolls sideways, or over a selection alone.
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
    let start: { x: number; y: number; id: number } | null = null
    let claimed = false
    let samples: { x: number; at: number }[] = []
    const touchOf = (event: TouchEvent) =>
      start === null
        ? undefined
        : Array.from(event.touches).find((touch) => touch.identifier === start!.id)
    const onStart = (event: TouchEvent) => {
      start = null
      claimed = false
      const touch = event.touches[0]
      const target = event.target instanceof Element ? event.target : null
      if (event.touches.length !== 1 || !touch || !target) {
        return
      }
      if (keepsItsDrags(target, node) || selecting()) {
        return
      }
      start = { x: touch.clientX, y: touch.clientY, id: touch.identifier }
      samples = [{ x: touch.clientX, at: event.timeStamp }]
    }
    const onMove = (event: TouchEvent) => {
      const touch = touchOf(event)
      if (!start || !touch) {
        return
      }
      const dx = touch.clientX - start.x
      const dy = touch.clientY - start.y
      if (!claimed) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) {
          return
        }
        // Rightward, vertical, or already scrolling: not ours for the rest of this touch.
        if (dx >= 0 || Math.abs(dx) < Math.abs(dy) * HORIZONTAL_DOMINANCE || !event.cancelable) {
          start = null
          return
        }
        claimed = true
        latest.current?.begin()
      }
      event.preventDefault()
      latest.current?.follow(dx)
      samples.push({ x: touch.clientX, at: event.timeStamp })
      samples = samples.filter((sample) => event.timeStamp - sample.at <= VELOCITY_WINDOW_MS)
    }
    const finish = (success: boolean) => {
      if (claimed) {
        const first = samples[0]
        const last = samples.at(-1)
        const elapsed = first && last ? last.at - first.at : 0
        const velocity = first && last && elapsed > 0 ? ((last.x - first.x) / elapsed) * 1000 : 0
        latest.current?.end(velocity, success)
      }
      start = null
      claimed = false
    }
    const onEnd = () => finish(true)
    const onCancel = () => finish(false)
    node.addEventListener('touchstart', onStart, { passive: true })
    // Not passive: a claimed swipe stops the page scrolling under it.
    node.addEventListener('touchmove', onMove, { passive: false })
    node.addEventListener('touchend', onEnd, { passive: true })
    node.addEventListener('touchcancel', onCancel, { passive: true })
    return () => {
      node.removeEventListener('touchstart', onStart)
      node.removeEventListener('touchmove', onMove)
      node.removeEventListener('touchend', onEnd)
      node.removeEventListener('touchcancel', onCancel)
    }
  }, [node, live])
  return (next: unknown) => setNode(next instanceof HTMLElement ? next : null)
}
