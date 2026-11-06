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
