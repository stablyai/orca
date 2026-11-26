import {
  BROWSER_GRAB_HOVER_ATTRIBUTE,
  BROWSER_GRAB_SELECTED_ATTRIBUTE
} from '../../../shared/browser/annotations/browser-annotation-viewport-bridge'

const HOST_ID = '__orca-grab-host'

/** The page world's description of a picked element's target, as the overlay script built it. */
export type PageTargetDescription = Record<string, unknown>

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
/** `host` is the one overlay host the arm added; null when it added none or more than one. */
export type ArmObservation<T> =
  | { ok: true; value: T; host: Element | null; added: Element[] }
  | { ok: false; added: Element[] }

export type BrowserGuestPickerAuthority = {
  /** Every overlay host the arm added anywhere in the document is reported, also when the arm failed. */
  observeArm: <T>(run: () => Promise<T>) => Promise<ArmObservation<T>>
  /** The live picker's host, left out of trusted hit tests; set only once an arm is accepted. */
  adopt: (host: Element | null) => void
  hostRemoved: (host: Element | null) => boolean
  /** Detaches hosts a failed arm left behind, through this world's own bindings. */
  discard: (hosts: readonly Element[]) => void
  /** Positive proof for a clean: no picker host is attached anywhere in this document's light DOM. */
  noOverlayHost: () => boolean
  /**
   * A frozen pick is the node the trusted press hit, a hover read the node under the trusted pointer; either must
   * carry the marker the page world set on the element its payload describes.
   */
  resolvePick: (host: Element | null, kind: 'held' | 'hover', marker: string) => Element | null
  present: (element: Element) => boolean
  snapshot: (element: Element) => PickedSnapshot | false
  /** The page world's target description with its tag and box taken from the trusted node; null if it is gone. */
  trustedTarget: (
    element: Element,
    described: PageTargetDescription
  ) => PageTargetDescription | null
}

const isPointerPosition = (event: Event): event is Event & { clientX: number; clientY: number } =>
  'clientX' in event &&
  typeof event.clientX === 'number' &&
  'clientY' in event &&
  typeof event.clientY === 'number'

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
  const track = (event: Event): void => {
    if (!isTrusted(event) || !isPointerPosition(event)) {
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
    window.addEventListener(type, track, { capture: true, passive: true })
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
  function snapshot(element: Element): PickedSnapshot | false {
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
  return {
    observeArm: async (run) => {
      const added: Element[] = []
      const collect = (records: MutationRecord[]): void => {
        for (const record of records) {
          for (const node of Array.from(record.addedNodes)) {
            if (node instanceof Element && node.id === HOST_ID && !added.includes(node)) {
              added.push(node)
            }
          }
        }
      }
      const observer = new MutationObserver(collect)
      observer.observe(document, { childList: true, subtree: true })
      try {
        const value = await run()
        collect(observer.takeRecords())
        const armed = added.length === 1 ? added[0] : null
        return { ok: true, value, host: armed, added }
      } catch {
        collect(observer.takeRecords())
        return { ok: false, added }
      } finally {
        observer.disconnect()
      }
    },
    adopt: (live) => {
      host = live
    },
    hostRemoved: (owned) => !owned || !owned.isConnected,
    discard: (hosts) => {
      for (const owned of hosts) {
        if (owned.isConnected) {
          owned.remove()
        }
      }
    },
    noOverlayHost: () => document.querySelector(`[id="${HOST_ID}"]`) === null,
    resolvePick: (owned, kind, marker) => {
      const element = kind === 'hover' ? hitTest(owned) : pressed
      if (!element || element === owned || !marker) {
        return null
      }
      const attribute =
        kind === 'hover' ? BROWSER_GRAB_HOVER_ATTRIBUTE : BROWSER_GRAB_SELECTED_ATTRIBUTE
      return element.getAttribute(attribute) === marker ? element : null
    },
    present: (element) => element.isConnected && element.ownerDocument === document,
    snapshot,
    trustedTarget: (element, described) => {
      const box = snapshot(element)
      return box
        ? {
            ...described,
            tagName: element.tagName.toLowerCase(),
            rectViewport: { x: box.x, y: box.y, width: box.width, height: box.height }
          }
        : null
    }
  }
}
