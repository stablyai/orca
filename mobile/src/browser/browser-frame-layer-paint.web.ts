import type { Image, View } from 'react-native'
import type { FrameLayer } from './mobile-browser-frame-state'
import type { BrowserFrameDisplayHandlers } from './browser-frame-layer-paint'

// RN Web refs are DOM nodes without setNativeProps; write Image’s first-child background and View opacity directly.
// Sibling accessibility img is prop-driven and retains mount frame until a pane render updates it.
function elementOf(node: Image | View | null): HTMLElement | null {
  return node instanceof HTMLElement ? node : null
}

export function updateBrowserLayerVisibility(
  layers: [View | null, View | null],
  visible: FrameLayer
): void {
  for (const [index, layer] of layers.entries()) {
    const element = elementOf(layer)
    if (element !== null) {
      element.style.opacity = index === visible ? '1' : '0'
    }
  }
}

export function updateBrowserImageSource(image: Image | null, uri: string): void {
  const host = elementOf(image)
  if (host === null) {
    return
  }
  // Paint child with existing background-size/position; host write would be unscaled behind layout styles.
  const surface = host.firstElementChild
  const target = surface instanceof HTMLElement ? surface : host
  // A data URI is base64 and a scheme, so it carries no quote to escape.
  target.style.backgroundImage = `url("${uri}")`
}

// Await shared-cache image decode before showing hidden layer: background writes emit no load event and would strand first frame.
export function whenBrowserFrameDisplayable(
  uri: string,
  handlers: BrowserFrameDisplayHandlers
): void {
  const probe = new window.Image()
  probe.src = uri
  probe.decode().then(handlers.onDisplayable, handlers.onUndecodable)
}
