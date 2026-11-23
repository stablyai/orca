import { BROWSER_GRAB_SELECTED_ATTRIBUTE } from '../../../shared/browser/annotations/browser-annotation-viewport-bridge'

const HOST_ID = '__orca-grab-host'

export type PickedSnapshot = {
  x: number
  y: number
  width: number
  height: number
  viewportWidth: number
}

/**
 * The isolated preload's own view of the picker, read through this world's unpatched DOM bindings.
 * Page scripts share the nodes but not these wrappers, so they cannot change which node is the
 * picked one, whether it is still attached, or whether the picker's overlay is really gone.
 */
export type BrowserGuestPickerAuthority = {
  /** The one overlay host an arm added; null when it added none or more than one. */
  observeArm: <T>(run: () => Promise<T>) => Promise<{ value: T; host: Element | null }>
  hostRemoved: (host: Element | null) => boolean
  /** A frozen pick is the node the trusted press hit and must carry its marker; a hover read is the node under the pointer. */
  resolvePick: (host: Element | null, marker: string | null) => Element | null
  present: (element: Element) => boolean
  snapshot: (element: Element) => PickedSnapshot | false
}

export function createBrowserGuestPickerAuthority(
  isTrusted: (event: Event) => boolean = (event) => event.isTrusted
): BrowserGuestPickerAuthority | null {
  if (
    typeof window === 'undefined' ||
    typeof document === 'undefined' ||
    typeof MutationObserver === 'undefined'
  ) {
    return null
  }
  let pointer: { x: number; y: number } | null = null
  let host: Element | null = null
  // Resolved inside the trusted press itself, before any page listener or callback can move nodes.
  let pressed: Element | null = null
  const track = (event: MouseEvent): void => {
    if (!isTrusted(event)) {
      return
    }
    pointer = { x: event.clientX, y: event.clientY }
    if (event.type === 'click' || event.type === 'contextmenu') {
      pressed = hitTest(host)
    }
  }
  // Installed before page scripts, so these run ahead of any page capture listener.
  for (const type of [
    'pointermove',
    'mousemove',
    'pointerdown',
    'mousedown',
    'click',
    'contextmenu'
  ]) {
    window.addEventListener(type, track as EventListener, { capture: true, passive: true })
  }
  function hitTest(overlayHost: Element | null): Element | null {
    if (!pointer) {
      return null
    }
    const style = overlayHost instanceof HTMLElement ? overlayHost.style : null
    const previous = style?.pointerEvents
    if (style) {
      style.pointerEvents = 'none'
    }
    try {
      let element = document.elementFromPoint(pointer.x, pointer.y)
      while (element?.shadowRoot) {
        const inner = element.shadowRoot.elementFromPoint(pointer.x, pointer.y)
        if (!inner || inner === element) {
          break
        }
        element = inner
      }
      return element
    } finally {
      if (style && previous !== undefined) {
        style.pointerEvents = previous
      }
    }
  }
  return {
    observeArm: async (run) => {
      const records: MutationRecord[] = []
      const observer = new MutationObserver((delivered) => records.push(...delivered))
      observer.observe(document.documentElement, { childList: true })
      try {
        const value = await run()
        records.push(...observer.takeRecords())
        const added = records
          .flatMap((record) => Array.from(record.addedNodes))
          .filter((node): node is Element => node instanceof Element && node.id === HOST_ID)
        const armed = added.length === 1 ? added[0] : null
        if (armed) {
          host = armed
        }
        return { value, host: armed }
      } finally {
        observer.disconnect()
      }
    },
    hostRemoved: (owned) => !owned || !owned.isConnected,
    resolvePick: (owned, marker) => {
      // A frozen pick is the node the trusted press hit; a hover read is the node under the pointer now.
      const element = marker === null ? hitTest(owned) : pressed
      if (!element || element === owned) {
        return null
      }
      return marker === null || element.getAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE) === marker
        ? element
        : null
    },
    present: (element) => element.isConnected && element.ownerDocument === document,
    snapshot: (element) => {
      if (!element.isConnected || element.ownerDocument !== document) {
        return false
      }
      const rect = element.getBoundingClientRect()
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        viewportWidth: window.innerWidth
      }
    }
  }
}
