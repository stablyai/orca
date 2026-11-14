import { createMobileNativeChatReadingHold } from './transcript/mobile-native-chat-reading-hold'
import { connectMobileNativeChatScrollGesture } from './transcript/mobile-native-chat-scroll-gesture'
import {
  externalAllowance,
  composerGroupOf as groupOf,
  fittingComposerSurface,
  revealComposerSurface,
  surfaceVisibility,
  focusedLowerElement
} from './mobile-native-chat-lower-geometry'

const BOTTOM_TOLERANCE = 4
const SCROLL_SETTLE_MS = 150
type RevealReason = 'focus' | 'edit' | 'menu'

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
  let pending: {
    group: HTMLElement | null
    target: HTMLElement
    reason: RevealReason
    navigation: number
  } | null = null
  let layoutPending = false
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
  const focused = () => focusedLowerElement(content)
  const recordActive = () => {
    const element = focused()
    const surface = element && fittingComposerSurface(element, viewport)
    active =
      element && surface
        ? {
            element,
            visible: surfaceVisibility(viewport, element).visible,
            clipped: surfaceVisibility(viewport, surface).clipped
          }
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
  const reconcile = () => {
    frame = null
    if (disposed) {
      return
    }
    observeOuterMovement()
    onGeometry(viewport.clientHeight, externalAllowance(root))
    if (gesture.active() || settling || viewport.scrollTop < 0 || viewport.scrollTop > maximum()) {
      return
    }
    const target = focused()
    if (pending && target === pending.target) {
      const requested = pending
      pending = null
      revealComposerSurface(viewport, target, requested.group, requested.reason === 'menu', write)
      attached = atBottom()
      reading.clear()
      if (!attached) {
        reading.refresh(false)
      }
    } else {
      pending = null
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
    layoutPending = false
    recordActive()
  }
  const schedule = () => {
    if (frame === null && !disposed) {
      frame = requestAnimationFrame(reconcile)
    }
  }
  const reveal = (group?: unknown, reason: RevealReason = 'focus') => {
    const target = focused()
    pending = target
      ? {
          group: group instanceof HTMLElement ? group : null,
          target,
          reason,
          navigation: gesture.version()
        }
      : null
    schedule()
  }
  const layoutChanged = () => {
    layoutPending = true
    const target = focused()
    const surface = target && fittingComposerSurface(target, viewport)
    const resized =
      viewportHeight !== viewport.clientHeight || viewportWidth !== viewport.clientWidth
    viewportHeight = viewport.clientHeight
    viewportWidth = viewport.clientWidth
    if (
      target &&
      surface &&
      !gesture.active() &&
      !settling &&
      !pending &&
      active?.element === target &&
      active.visible &&
      (resized || surfaceVisibility(viewport, surface).clipped > active.clipped + 0.5)
    ) {
      reveal(groupOf(target), 'edit')
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
      gesture.settled()
      schedule()
    }, SCROLL_SETTLE_MS)
  }
  const observeOuterMovement = () => {
    const position = viewport.scrollTop
    const limit = maximum()
    const extentChanged = limit !== lastMaximum
    const previous = limit < lastMaximum ? Math.min(lastScroll, limit) : lastScroll
    const delta = position - previous
    lastScroll = position
    lastMaximum = limit
    if (Math.abs(delta) < 0.5) {
      return false
    }
    if (pending && gesture.version() > pending.navigation) {
      pending = null
    }
    if (pending) {
      return false
    }
    if (!gesture.navigating()) {
      if (!attached && !layoutPending && !extentChanged) {
        reading.move(delta)
        reading.refresh(false)
        attached = atBottom()
        recordActive()
      }
      schedule()
      return false
    }
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
    if (pending && gesture.version() > pending.navigation) {
      pending = null
    }
    if (pending || !gesture.navigating()) {
      schedule()
      return
    }
    if (!attached) {
      reading.refresh()
    }
    recordActive()
    settleLater()
  }
  const gesture = connectMobileNativeChatScrollGesture(
    viewport,
    () => {
      pending = null
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
    gesture.settled()
    schedule()
  }
  const onFocus = () => reveal()
  const onInput = () => reveal(undefined, 'edit')
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
  viewport.addEventListener('input', onInput)
  viewport.addEventListener('scroll', onScroll, true)
  viewport.addEventListener('scrollend', onScrollEnd)
  onGeometry(viewport.clientHeight, externalAllowance(root))
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
      viewport.removeEventListener('input', onInput)
      viewport.removeEventListener('scroll', onScroll, true)
      viewport.removeEventListener('scrollend', onScrollEnd)
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
      if (settle !== null) {
        clearTimeout(settle)
      }
      reading.clear()
      pending = null
    }
  }
}
