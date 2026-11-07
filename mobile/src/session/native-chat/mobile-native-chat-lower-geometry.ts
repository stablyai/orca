export function externalAllowance(root: HTMLElement | null): number {
  if (!root || !visible(root)) {
    return 0
  }
  const rect = root.getBoundingClientRect()
  const style = getComputedStyle(root)
  const viewport = window.visualViewport
  let top = Math.max(
    rect.top +
      (Number.parseFloat(style.borderTopWidth) || 0) +
      (Number.parseFloat(style.paddingTop) || 0),
    viewport?.offsetTop ?? 0
  )
  let bottom = Math.min(
    rect.bottom -
      (Number.parseFloat(style.borderBottomWidth) || 0) -
      (Number.parseFloat(style.paddingBottom) || 0),
    window.innerHeight,
    viewport ? viewport.offsetTop + viewport.height : window.innerHeight
  )
  for (let parent = root.parentElement; parent; parent = parent.parentElement) {
    const computed = getComputedStyle(parent)
    if (/(auto|scroll|hidden|clip)/.test(computed.overflowY || computed.overflow)) {
      const bounds = parent.getBoundingClientRect()
      top = Math.max(top, bounds.top)
      bottom = Math.min(bottom, bounds.bottom)
    }
  }
  return Math.max(0, bottom - top)
}

export function visible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect()
  return element.isConnected && rect.width > 0 && rect.height > 0
}

export function composerGroupOf(target: HTMLElement): HTMLElement {
  return (
    target.closest<HTMLElement>('[data-testid="queued-card-editor"]') ??
    target.closest<HTMLElement>('[data-testid="native-chat-composer-group"]') ??
    target
  )
}

export function fittingComposerSurface(target: HTMLElement, viewport: HTMLElement): HTMLElement {
  for (const surface of [
    composerGroupOf(target),
    target.closest<HTMLElement>('[data-testid="native-chat-composer-inset"]'),
    target.closest<HTMLElement>('[data-testid="native-chat-composer"]')
  ]) {
    if (
      surface &&
      visible(surface) &&
      surface.getBoundingClientRect().height <= viewport.clientHeight
    ) {
      return surface
    }
  }
  return target
}

function revealOffset(viewport: HTMLElement, target: HTMLElement, bottom: boolean): number {
  const bounds = viewport.getBoundingClientRect()
  const rect = target.getBoundingClientRect()
  if (
    rect.height > viewport.clientHeight ||
    (rect.top >= bounds.top && rect.bottom <= bounds.bottom)
  ) {
    return 0
  }
  if (bottom || rect.bottom > bounds.bottom) {
    return rect.bottom - bounds.bottom
  }
  return rect.top - bounds.top
}

export function surfaceVisibility(viewport: HTMLElement, target: HTMLElement) {
  const rect = target.getBoundingClientRect()
  const bounds = viewport.getBoundingClientRect()
  return {
    visible: rect.bottom > bounds.top && rect.top < bounds.bottom,
    clipped: Math.max(0, bounds.top - rect.top) + Math.max(0, rect.bottom - bounds.bottom)
  }
}

export function focusedLowerElement(content: HTMLElement): HTMLElement | null {
  const target = content.ownerDocument.activeElement
  return target instanceof HTMLElement && content.contains(target) && visible(target)
    ? target
    : null
}

export function revealComposerSurface(
  viewport: HTMLElement,
  target: HTMLElement,
  requested: HTMLElement | null,
  menu: boolean,
  write: (node: HTMLElement, offset: number) => void
) {
  for (
    let parent = target.parentElement;
    parent && parent !== viewport;
    parent = parent.parentElement
  ) {
    const style = getComputedStyle(parent)
    if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight) {
      write(
        parent,
        parent.scrollTop + revealOffset(parent, fittingComposerSurface(target, parent), false)
      )
    }
  }
  const group =
    target.closest<HTMLElement>('[data-testid="queued-card-editor"]') ??
    (requested && requested.contains(target) && visible(requested)
      ? requested
      : composerGroupOf(target))
  const surface =
    group.getBoundingClientRect().height <= viewport.clientHeight
      ? group
      : fittingComposerSurface(target, viewport)
  write(viewport, viewport.scrollTop + revealOffset(viewport, surface, menu && surface !== group))
}
