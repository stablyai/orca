import { createMobileNativeChatReadingHold } from './mobile-native-chat-reading-hold'
import { connectMobileNativeChatScrollGesture } from './mobile-native-chat-scroll-gesture'
import { externalAllowance, visible } from './mobile-native-chat-lower-geometry'

const BOTTOM_TOLERANCE = 4
const SCROLL_SETTLE_MS = 150

function groupOf(target: HTMLElement): HTMLElement {
  return (
    target.closest<HTMLElement>('[data-testid="queued-card-editor"]') ??
    target.closest<HTMLElement>('[data-testid="native-chat-composer-group"]') ??
    target
  )
}

export function connectMobileNativeChatLowerScroll(
  viewport: HTMLElement,
  content: HTMLElement,
  onGeometry: (height: number, allowance: number) => void
) {
  let attached = true
  const reading = createMobileNativeChatReadingHold(viewport, content)
  let lastScroll = viewport.scrollTop
  let lastMaximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
  let active: { element: HTMLElement; visible: boolean; clipped: number } | null = null
  let pending: HTMLElement | null | undefined
  let frame: number | null = null
  let settle: ReturnType<typeof setTimeout> | null = null
  let settling = false
  let disposed = false
  let viewportHeight = viewport.clientHeight
  let viewportWidth = viewport.clientWidth
  const ownWrites = new WeakMap<HTMLElement, number>()
  const document = viewport.ownerDocument
  const root = viewport.closest<HTMLElement>('[data-testid="native-chat-view"]')
  const priorAnchoring = viewport.style.overflowAnchor
  viewport.style.overflowAnchor = 'none'

  const maximum = () => Math.max(0, viewport.scrollHeight - viewport.clientHeight)
  const atBottom = () => maximum() - viewport.scrollTop <= BOTTOM_TOLERANCE
  const focused = () => {
    const target = document.activeElement
    return target instanceof HTMLElement && content.contains(target) && visible(target)
      ? target
      : null
  }
  const intersectsViewport = (target: HTMLElement) => {
    const rect = target.getBoundingClientRect()
    const bounds = viewport.getBoundingClientRect()
    return rect.bottom > bounds.top && rect.top < bounds.bottom
  }
  const clipping = (target: HTMLElement) => {
    const rect = target.getBoundingClientRect()
    const bounds = viewport.getBoundingClientRect()
    return Math.max(0, bounds.top - rect.top) + Math.max(0, rect.bottom - bounds.bottom)
  }
  const recordActive = () => {
    const element = focused()
    active = element
      ? { element, visible: intersectsViewport(element), clipped: clipping(element) }
      : null
  }
  const write = (node: HTMLElement, offset: number) => {
    const next = Math.max(0, Math.min(offset, node.scrollHeight - node.clientHeight))
    if (Math.abs(next - node.scrollTop) < 0.5) {
      return
    }
    node.scrollTop = next
    ownWrites.set(node, node.scrollTop)
    if (node === viewport) {
      lastScroll = node.scrollTop
      lastMaximum = maximum()
    }
  }
  const expose = (node: HTMLElement, target: HTMLElement) => {
    const bounds = node.getBoundingClientRect()
    const rect = target.getBoundingClientRect()
    const delta =
      rect.top < bounds.top
        ? rect.top - bounds.top
        : rect.bottom > bounds.bottom
          ? rect.bottom - bounds.bottom
          : 0
    write(node, node.scrollTop + delta)
  }
  const reconcile = () => {
    frame = null
    if (disposed) {
      return
    }
    observeOuterMovement()
    if (gesture.active() || settling || viewport.scrollTop < 0 || viewport.scrollTop > maximum()) {
      return
    }
    onGeometry(viewport.clientHeight, externalAllowance(root))
    const target = focused()
    if (pending !== undefined && target) {
      const requested = pending
      pending = undefined
      for (
        let parent = target.parentElement;
        parent && parent !== viewport;
        parent = parent.parentElement
      ) {
        const style = getComputedStyle(parent)
        if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight) {
          expose(parent, target)
        }
      }
      const group =
        target.closest<HTMLElement>('[data-testid="queued-card-editor"]') ??
        (requested && requested.contains(target) && visible(requested)
          ? requested
          : groupOf(target))
      expose(
        viewport,
        group.getBoundingClientRect().height <= viewport.clientHeight ? group : target
      )
      attached = atBottom()
      reading.clear()
      if (!attached) {
        reading.refresh(false)
      }
    } else {
      pending = undefined
      if (attached) {
        write(viewport, maximum())
      } else {
        write(viewport, viewport.scrollTop + (reading.displacement() ?? 0))
      }
      if (attached) {
        reading.clear()
      } else {
        reading.refresh(false)
      }
    }
    recordActive()
  }
  const schedule = () => {
    if (frame === null && !disposed) {
      frame = requestAnimationFrame(reconcile)
    }
  }
  const reveal = (group?: unknown) => {
    pending = group instanceof HTMLElement ? group : null
    schedule()
  }
  const layoutChanged = () => {
    const target = focused()
    const resized =
      viewportHeight !== viewport.clientHeight || viewportWidth !== viewport.clientWidth
    viewportHeight = viewport.clientHeight
    viewportWidth = viewport.clientWidth
    if (
      target &&
      (resized ||
        (active?.element === target && active.visible && clipping(target) > active.clipped + 0.5))
    ) {
      pending = groupOf(target)
    }
    schedule()
  }
  const settleLater = () => {
    if (settle !== null) {
      clearTimeout(settle)
    }
    settling = true
    settle = setTimeout(() => {
      settle = null
      settling = false
      schedule()
    }, SCROLL_SETTLE_MS)
  }
  const observeOuterMovement = () => {
    const position = viewport.scrollTop
    const limit = maximum()
    const previous = limit < lastMaximum ? Math.min(lastScroll, limit) : lastScroll
    const delta = position - previous
    lastScroll = position
    lastMaximum = limit
    if (Math.abs(delta) < 0.5) {
      return false
    }
    pending = undefined
    reading.move(delta)
    attached = atBottom()
    if (attached) {
      reading.clear()
    } else {
      reading.refresh()
    }
    recordActive()
    settleLater()
    return true
  }
  const onScroll = (event: Event) => {
    const node = event.target
    if (!(node instanceof HTMLElement)) {
      return
    }
    const own = ownWrites.get(node)
    ownWrites.delete(node)
    if (own !== undefined && Math.abs(own - node.scrollTop) < 1) {
      return
    }
    const moved = observeOuterMovement()
    if (node === viewport) {
      if (!moved) {
        schedule()
      }
      return
    }
    pending = undefined
    if (!attached) {
      reading.refresh()
    }
    recordActive()
    settleLater()
  }
  const gesture = connectMobileNativeChatScrollGesture(
    viewport,
    () => {
      pending = undefined
    },
    settleLater
  )
  const onScrollEnd = (event: Event) => {
    if (event.target !== viewport) {
      return
    }
    if (settle !== null) {
      clearTimeout(settle)
      settle = null
    }
    settling = false
    schedule()
  }
  const onFocus = () => reveal()
  const observer = new ResizeObserver(layoutChanged)
  observer.observe(viewport)
  observer.observe(content)
  for (let parent = root; parent; parent = parent.parentElement) {
    observer.observe(parent)
  }
  const onPageScroll = (event: Event) => {
    if (
      event.target === document ||
      (event.target instanceof Node && event.target !== viewport && event.target.contains(viewport))
    ) {
      layoutChanged()
    }
  }
  window.addEventListener('resize', layoutChanged)
  window.addEventListener('scroll', onPageScroll, true)
  window.visualViewport?.addEventListener('resize', layoutChanged)
  window.visualViewport?.addEventListener('scroll', layoutChanged)
  viewport.addEventListener('focusin', onFocus)
  viewport.addEventListener('scroll', onScroll, true)
  viewport.addEventListener('scrollend', onScrollEnd)
  if (focused()) {
    reveal()
  } else {
    schedule()
  }
  return {
    reveal,
    layoutChanged,
    dispose: () => {
      disposed = true
      observer.disconnect()
      gesture.dispose()
      window.removeEventListener('resize', layoutChanged)
      window.removeEventListener('scroll', onPageScroll, true)
      window.visualViewport?.removeEventListener('resize', layoutChanged)
      window.visualViewport?.removeEventListener('scroll', layoutChanged)
      viewport.style.overflowAnchor = priorAnchoring
      viewport.removeEventListener('focusin', onFocus)
      viewport.removeEventListener('scroll', onScroll, true)
      viewport.removeEventListener('scrollend', onScrollEnd)
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
      if (settle !== null) {
        clearTimeout(settle)
      }
      reading.clear()
      pending = undefined
    }
  }
}
