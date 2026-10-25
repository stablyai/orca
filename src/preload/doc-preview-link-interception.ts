// Runs in the isolated world so page scripts cannot access the link reporter or its listeners.
export type DocPreviewExternalLinkReporter = (url: string) => void

// Keep this literal: shared imports emit chunk requires the sandboxed preload cannot load.
export const PRELOAD_DOC_PREVIEW_LINK_CLICK_CHANNEL = 'docPreview:linkClick'

// SVG anchors carry an SVGAnimatedString href and are not HTMLAnchorElements.
function readAnchorHref(node: EventTarget): string | null {
  const element = node as { tagName?: unknown; href?: unknown }
  if (typeof element.tagName !== 'string' || element.tagName.toUpperCase() !== 'A') {
    return null
  }
  if (typeof element.href === 'string') {
    return element.href.length > 0 ? element.href : null
  }
  const baseVal = (element.href as { baseVal?: unknown } | null | undefined)?.baseVal
  if (typeof baseVal !== 'string' || baseVal.length === 0) {
    return null
  }
  // SVG baseVal is relative; normalize it to match HTML anchors' absolute hrefs.
  try {
    return new URL(baseVal, window.location.href).toString()
  } catch {
    return null
  }
}

// The anchor may wrap the clicked element, including across a shadow root.
function findClickedAnchor(event: Event): { element: EventTarget; href: string } | null {
  for (const node of event.composedPath()) {
    const href = readAnchorHref(node)
    if (href !== null) {
      return { element: node, href }
    }
  }
  return null
}

function scrollToDocumentTop(): void {
  window.scrollTo(0, 0)
}

function readAttribute(element: EventTarget, name: string): string | null {
  const candidate = element as { getAttribute?: (attribute: string) => string | null }
  return typeof candidate.getAttribute === 'function' ? candidate.getAttribute(name) : null
}

function scrollToFragment(fragment: string): void {
  let target = document.getElementById(fragment)
  if (!target) {
    try {
      target = document.getElementById(decodeURIComponent(fragment))
    } catch {
      target = null
    }
  }
  if (target) {
    target.scrollIntoView()
    return
  }
  // #top also works without a matching element.
  if (fragment === 'top') {
    scrollToDocumentTop()
  }
}

function handleInDocumentFragment(element: EventTarget, href: string): boolean {
  if (readAttribute(element, 'href') === '#') {
    scrollToDocumentTop()
    return true
  }
  const hashIndex = href.indexOf('#')
  if (hashIndex === -1) {
    return false
  }
  const currentHref = window.location.href
  const currentHashIndex = currentHref.indexOf('#')
  const currentBase = currentHashIndex === -1 ? currentHref : currentHref.slice(0, currentHashIndex)
  if (href.slice(0, hashIndex) !== currentBase) {
    return false
  }
  scrollToFragment(href.slice(hashIndex + 1))
  return true
}

function isSameSchemeAsDocument(href: string): boolean {
  try {
    return new URL(href).protocol === window.location.protocol
  } catch {
    return false
  }
}

export function handleDocPreviewLinkClick(
  event: Event,
  report: DocPreviewExternalLinkReporter
): void {
  // Only user clicks may open external links.
  if (!event.isTrusted) {
    return
  }
  const anchor = findClickedAnchor(event)
  if (!anchor) {
    return
  }
  if (handleInDocumentFragment(anchor.element, anchor.href)) {
    event.preventDefault()
    return
  }
  // Let the guest navigate sibling preview documents to preserve its history.
  if (isSameSchemeAsDocument(anchor.href)) {
    return
  }
  event.preventDefault()
  report(anchor.href)
}

export function handleDocPreviewLinkAuxClick(event: MouseEvent): void {
  if (!event.isTrusted || event.button !== 1) {
    return
  }
  if (!findClickedAnchor(event)) {
    return
  }
  // Suppress middle-click navigation to avoid opening an external background tab.
  event.preventDefault()
}

export function installDocPreviewLinkInterception(report: DocPreviewExternalLinkReporter): void {
  // Capture before the document's handlers can consume the click.
  document.addEventListener('click', (event) => handleDocPreviewLinkClick(event, report), true)
  document.addEventListener(
    'auxclick',
    (event) => handleDocPreviewLinkAuxClick(event as MouseEvent),
    true
  )
}
