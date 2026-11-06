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
  let hold: { element: HTMLElement; offset: number } | null = null
  let lastScroll = viewport.scrollTop
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
  const capture = () => {
    const rect = viewport.getBoundingClientRect()
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + Math.min(4, rect.height / 2)
    )
    hold =
      hit instanceof HTMLElement && hit !== content && content.contains(hit) && visible(hit)
        ? { element: hit, offset: hit.getBoundingClientRect().top - rect.top }
        : null
  }
  const write = (node: HTMLElement, offset: number) => {
    const next = Math.max(0, Math.min(offset, node.scrollHeight - node.clientHeight))
    if (Math.abs(next - node.scrollTop) < 0.5) {
      return
    }
    ownWrites.set(node, next)
    node.scrollTop = next
    if (node === viewport) {
      lastScroll = next
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
    if (disposed || gesture.active() || settling) {
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
      if (!attached) {
        capture()
      }
    } else {
      pending = undefined
      if (attached) {
        write(viewport, maximum())
      } else if (hold && content.contains(hold.element) && visible(hold.element)) {
        const displacement =
          hold.element.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top -
          hold.offset
        write(viewport, viewport.scrollTop + displacement)
      } else {
        write(viewport, viewport.scrollTop)
      }
      if (!attached) {
        capture()
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
    pending = undefined
    if (node === viewport) {
      const delta = node.scrollTop - lastScroll
      if (hold) {
        hold.offset -= delta
      }
      lastScroll = node.scrollTop
      attached = atBottom()
      if (!attached) {
        capture()
      }
    } else {
      if (!attached) {
        capture()
      }
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
  const onScrollEnd = () => {
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
      hold = null
      pending = undefined
    }
  }
}
