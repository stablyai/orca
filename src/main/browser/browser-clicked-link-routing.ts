export const BROWSER_CLICKED_LINK_ROUTING_WORLD_ID = 1208

type BrowserClickedLinkRoutingState = {
  frameName: string
  isMac: boolean
  allowUntrustedEvents: boolean
  listener: (event: MouseEvent) => void
}

type BrowserClickedLinkRoutingGlobal = typeof globalThis & {
  __orcaBrowserClickedLinkRouting?: BrowserClickedLinkRoutingState
}

/**
 * Re-expresses explicit new-tab link gestures with private frame names so main
 * can distinguish them from opener-dependent window.open calls.
 */
export function installBrowserClickedLinkRouting(
  frameName: string,
  isMac: boolean,
  allowUntrustedEvents = false
): void {
  const routingGlobal = globalThis as BrowserClickedLinkRoutingGlobal
  const existing = routingGlobal.__orcaBrowserClickedLinkRouting
  if (existing) {
    existing.frameName = frameName
    existing.isMac = isMac
    existing.allowUntrustedEvents = allowUntrustedEvents
    return
  }

  const state: BrowserClickedLinkRoutingState = {
    frameName,
    isMac,
    allowUntrustedEvents,
    listener: () => {}
  }
  state.listener = (event) => {
    const primaryClick = event.type === 'click' && event.button === 0
    const middleClick = event.type === 'auxclick' && event.button === 1
    if (
      !(event instanceof MouseEvent) ||
      (!event.isTrusted && !state.allowUntrustedEvents) ||
      (!primaryClick && !middleClick) ||
      event.defaultPrevented ||
      event.altKey
    ) {
      return
    }

    const link = event
      .composedPath()
      .find(
        (target): target is Element =>
          target instanceof Element &&
          ((target.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
            (target.localName === 'a' || target.localName === 'area')) ||
            (target.namespaceURI === 'http://www.w3.org/2000/svg' && target.localName === 'a'))
      )
    if (!link || link.hasAttribute('download')) {
      return
    }

    const modifierClick = state.isMac ? event.metaKey : event.ctrlKey
    const otherPlatformModifier = state.isMac ? event.ctrlKey : event.metaKey
    if (otherPlatformModifier) {
      return
    }
    // Shift alone is browser-native new-window intent; keep OAuth and other
    // opener-dependent window flows in Orca's guarded popup window.
    if (event.shiftKey && !modifierClick) {
      return
    }

    const baseTarget = document.querySelector('base[target]')?.getAttribute('target') ?? ''
    const ownTarget = link.getAttribute('target')
    const effectiveTarget = (ownTarget === null ? baseTarget : ownTarget).trim().toLowerCase()
    const opensNewContext = middleClick || modifierClick
    if (!opensNewContext && effectiveTarget !== '_blank') {
      return
    }

    const rawHref =
      link.getAttribute('href') ?? link.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
    if (rawHref === null) {
      return
    }

    let targetUrl: URL
    try {
      targetUrl = new URL(rawHref, document.baseURI)
    } catch {
      return
    }
    if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
      return
    }

    if (!opensNewContext) {
      // Why: changing only the browsing context keeps Chromium's native anchor
      // navigation, including referrer policy, attribution, and history.
      link.setAttribute('target', '_self')
      return
    }

    // Why: Electron reports direct link clicks and featureless window.open()
    // with the same disposition. The private frame name preserves that one
    // distinction without weakening OAuth popups that need window.opener.
    event.preventDefault()
    window.open(targetUrl.toString(), state.frameName)
  }
  routingGlobal.__orcaBrowserClickedLinkRouting = state

  // Why: page click handlers must get the first chance to cancel or rewrite a
  // link; capture-phase interception breaks SPA routing and analytics handlers.
  window.addEventListener('click', state.listener, false)
  window.addEventListener('auxclick', state.listener, false)
}

/**
 * Keeps plain target=_blank clicks inside the top-level guest when Electron's
 * isolated-world API cannot target a child frame.
 */
export function installBrowserIframeClickedLinkRouting(
  frameName: string,
  isMac: boolean,
  allowUntrustedEvents = false
): () => void {
  const listener = (event: MouseEvent): void => {
    const primaryClick = event.type === 'click' && event.button === 0
    const middleClick = event.type === 'auxclick' && event.button === 1
    if (
      !(event instanceof MouseEvent) ||
      (!event.isTrusted && !allowUntrustedEvents) ||
      (!primaryClick && !middleClick) ||
      event.defaultPrevented ||
      event.altKey
    ) {
      return
    }

    const link = event
      .composedPath()
      .find(
        (target): target is Element =>
          target instanceof Element &&
          ((target.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
            (target.localName === 'a' || target.localName === 'area')) ||
            (target.namespaceURI === 'http://www.w3.org/2000/svg' && target.localName === 'a'))
      )
    if (!link || link.hasAttribute('download')) {
      return
    }

    const modifierClick = isMac ? event.metaKey : event.ctrlKey
    const otherPlatformModifier = isMac ? event.ctrlKey : event.metaKey
    if (otherPlatformModifier || (event.shiftKey && !modifierClick)) {
      return
    }

    const baseTarget = document.querySelector('base[target]')?.getAttribute('target') ?? ''
    const ownTarget = link.getAttribute('target')
    const effectiveTarget = (ownTarget === null ? baseTarget : ownTarget).trim().toLowerCase()
    const opensNewContext = middleClick || modifierClick
    if (!opensNewContext && effectiveTarget !== '_blank') {
      return
    }

    const rawHref =
      link.getAttribute('href') ?? link.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
    if (rawHref === null) {
      return
    }

    let targetUrl: URL
    try {
      targetUrl = new URL(rawHref, document.baseURI)
    } catch {
      return
    }
    if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
      return
    }

    if (!opensNewContext) {
      // Why: WebContents isolated worlds only cover the main frame. Rewriting
      // to `_top` preserves native anchor semantics without opening a popup.
      link.setAttribute('target', '_top')
      return
    }

    // Why: child-frame code runs in the page world, so each token is one-use.
    // A page that observes a real click cannot replay it to create more tabs.
    event.preventDefault()
    cleanup()
    window.open(targetUrl.toString(), frameName)
  }

  const cleanup = (): void => {
    window.removeEventListener('click', listener, false)
    window.removeEventListener('auxclick', listener, false)
  }
  window.addEventListener('click', listener, false)
  window.addEventListener('auxclick', listener, false)
  return cleanup
}

export function buildBrowserClickedLinkRoutingScript(frameName: string, isMac: boolean): string {
  return `(${installBrowserClickedLinkRouting.toString()})(${JSON.stringify(frameName)},${JSON.stringify(isMac)});`
}

export function buildBrowserIframeClickedLinkRoutingScript(
  frameName: string,
  isMac: boolean
): string {
  return `void (${installBrowserIframeClickedLinkRouting.toString()})(${JSON.stringify(frameName)},${JSON.stringify(isMac)});`
}
