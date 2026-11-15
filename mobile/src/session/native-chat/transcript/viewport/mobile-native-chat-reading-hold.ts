import { visible } from '../../lower-region/mobile-native-chat-lower-geometry'

export function createMobileNativeChatReadingHold(viewport: HTMLElement, content: HTMLElement) {
  let hold: { element: HTMLElement; offset: number } | null = null
  const innerOffset = (element: HTMLElement) => {
    let offset = 0
    for (
      let parent = element.parentElement;
      parent && parent !== viewport;
      parent = parent.parentElement
    ) {
      offset += parent.scrollTop
    }
    return offset
  }
  const edge = (element: HTMLElement) =>
    element.getBoundingClientRect().top -
    viewport.getBoundingClientRect().top +
    innerOffset(element)
  const witness = () =>
    hold && content.contains(hold.element) && visible(hold.element) ? hold : null
  const displacement = () => {
    const current = witness()
    return current ? edge(current.element) - current.offset : null
  }
  const refresh = (preserve = true) => {
    const old = witness()
    const debt = preserve && old ? edge(old.element) - old.offset : 0
    const bounds = viewport.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) {
      hold = null
      return
    }
    let hit = viewport.ownerDocument.elementFromPoint(
      bounds.left + bounds.width / 2,
      bounds.top + Math.min(4, bounds.height / 2)
    )
    while (hit && content.contains(hit) && !(hit instanceof HTMLElement)) {
      hit = hit.parentElement
    }
    if (hit instanceof HTMLElement && hit !== content && content.contains(hit) && visible(hit)) {
      const rect = hit.getBoundingClientRect()
      if (rect.bottom > bounds.top && rect.top < bounds.bottom) {
        // The new edge inherits the correction that has not yet reached scrollTop.
        hold = { element: hit, offset: edge(hit) - debt }
        return
      }
    }
    if (old) {
      const offset = preserve ? old.offset : edge(old.element)
      const intended = offset - innerOffset(old.element)
      const rect = old.element.getBoundingClientRect()
      if (intended < bounds.height && intended + rect.height > 0) {
        hold = { element: old.element, offset }
        return
      }
    }
    hold = null
  }
  return {
    displacement,
    refresh,
    move: (delta: number) => {
      if (hold) {
        hold.offset -= delta
      }
    },
    clear: () => {
      hold = null
    }
  }
}
