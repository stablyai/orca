/**
 * Decides what a click inside a preview guest means. This is the only way a URL leaves the
 * preview, so it answers for a click the reader really made: navigation the document starts by
 * itself never reaches here, and the guest's navigation policy refuses it outright.
 *
 * Runs in the guest's isolated world and exposes nothing to page script — the document cannot see
 * these listeners, remove them, or call what they call.
 */
export type DocPreviewExternalLinkReporter = (url: string) => void

/**
 * Why the channel name is written out rather than imported: this module is bundled into a
 * sandboxed preload, whose `require` resolves only 'electron', so an import of shared code emits a
 * chunk require the guest cannot load. The test pins it to the constant main listens on.
 */
export const PRELOAD_DOC_PREVIEW_LINK_CLICK_CHANNEL = 'docPreview:linkClick'

/** Why not `instanceof HTMLAnchorElement`: an SVG `<a>` is an anchor too, and carries an SVGAnimatedString href. */
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
  // Why resolved here: baseVal is the raw attribute, unlike an HTML anchor's absolute href, so
  // every branch below would read an SVG link differently from the identical HTML one.
  try {
    return new URL(baseVal, window.location.href).toString()
  } catch {
    return null
  }
}

/** Why the composed path and not `event.target`: the press lands on whatever the anchor wraps, shadow roots included. */
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
  // Why: `#top` names the top of the document even when nothing carries that id.
  if (fragment === 'top') {
    scrollToDocumentTop()
  }
}

/** True when the href only moves within the document already on screen, which this handles itself. */
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
  // Why first: a click the page dispatched is the document asking to leave, not the reader.
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
  // Why left alone: a link served the way this document was is a sibling preview document, which
  // the guest policy already answers for — it navigates natively and the preview keeps its history.
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
  // Why swallowed rather than routed: a middle click asks for a background tab, and honouring it
  // would let one press the reader barely registered open a browser tab.
  event.preventDefault()
}

export function installDocPreviewLinkInterception(report: DocPreviewExternalLinkReporter): void {
  // Why capture: the document's own handlers must not be able to consume the press first.
  document.addEventListener('click', (event) => handleDocPreviewLinkClick(event, report), true)
  document.addEventListener(
    'auxclick',
    (event) => handleDocPreviewLinkAuxClick(event as MouseEvent),
    true
  )
}
