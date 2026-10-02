import type { Image, View } from 'react-native'
import type { FrameLayer } from './mobile-browser-frame-state'
import type { BrowserFrameDisplayHandlers } from './browser-frame-layer-paint'

/**
 * Web sibling: on RN Web a ref is the DOM node itself and `setNativeProps` does not exist, so the
 * native writes throw rather than paint. RN Web renders an `<Image>` as a host element whose first
 * child carries the `background-image`, and a `<View>` as one element, so a frame is still one
 * style write per layer.
 *
 * The accessibility `<img>` RN Web renders beside the frame is a prop, not a style, so the
 * streaming writes never move it: it holds the frame the layers mounted with, which is what a
 * screen reader and the browser's image context menu see.
 */
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
  // The child is where `resizeMode` already put `background-size`/`background-position`; writing
  // the host instead would paint the frame unscaled behind RN Web's own layout styles.
  const surface = host.firstElementChild
  const target = surface instanceof HTMLElement ? surface : host
  // A data URI is base64 and a scheme, so it carries no quote to escape.
  target.style.backgroundImage = `url("${uri}")`
}

/**
 * Decode the frame before the layer holding it is allowed to become visible.
 *
 * A background write fires no load event, so without this the pending layer is never flipped and
 * the pane freezes on its first frame. The probe shares the document's image cache with the layer,
 * so the decode awaited here is the one the flip is waiting for rather than a second copy.
 */
export function whenBrowserFrameDisplayable(
  uri: string,
  handlers: BrowserFrameDisplayHandlers
): void {
  const probe = new window.Image()
  probe.src = uri
  probe.decode().then(handlers.onDisplayable, handlers.onUndecodable)
}
