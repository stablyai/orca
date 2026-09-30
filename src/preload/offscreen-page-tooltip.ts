// Why flat tree: Blink walks it from the hovered node, so slotted content inherits the slot's title.
function flatTreeParent(node: Node): Node | null {
  const slot = node instanceof Element || node instanceof Text ? node.assignedSlot : null
  if (slot) {
    return slot
  }
  const parent = node.parentNode
  return parent instanceof ShadowRoot ? parent.host : parent
}

/** Element::title(): null means "no title here, keep looking", "" stops the search. */
function elementTitle(element: Element): string | null {
  if (element instanceof SVGElement) {
    const title = [...element.children].find((child) => child instanceof SVGTitleElement)
    return title ? (title.textContent ?? '') : null
  }
  return element instanceof HTMLElement ? element.getAttribute('title') : null
}

/** Element::DefaultToolTip(): selected file names, or why the field is invalid. */
function defaultTooltip(element: Element): string {
  if (element instanceof HTMLInputElement && element.type === 'file') {
    const names = [...(element.files ?? [])].map((file) => file.name)
    return names.length > 0 ? names.join('\n') : 'No file chosen'
  }
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    return element.form?.noValidate ? '' : element.validationMessage
  }
  return ''
}

/** The tooltip Chromium shows for the hovered node (Chrome::SetToolTip). */
export function tooltipForNode(target: Node | null): string {
  for (let node = target; node; node = flatTreeParent(node)) {
    const title = node instanceof Element ? elementTitle(node) : null
    if (title !== null) {
      return title
    }
  }
  return target instanceof Element ? defaultTooltip(target) : ''
}

/**
 * Reports the frame's tooltip whenever the hovered node's tooltip changes. An offscreen page has
 * no native view, so Chromium's own tooltip never shows; Orca shows this one on the page canvas.
 */
export function installTooltipReporter(report: (text: string) => void): void {
  let reported: string | null = null
  addEventListener(
    'mousemove',
    (event) => {
      const [target] = event.composedPath()
      const text = tooltipForNode(target instanceof Node ? target : null)
      if (text !== reported) {
        reported = text
        report(text)
      }
    },
    { capture: true, passive: true }
  )
  // Why forget on leave: another frame reports while the pointer is away, so re-entry must resend.
  document.addEventListener('mouseleave', () => {
    reported = null
  })
}
