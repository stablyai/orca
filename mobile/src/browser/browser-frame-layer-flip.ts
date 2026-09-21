import type { View } from 'react-native'
import { updateBrowserLayerVisibility } from './browser-frame-layer-paint'
import type { FrameLayer } from './mobile-browser-frame-state'

export type BrowserFrameLayerRefs = {
  browserLayerRefs: { current: [View | null, View | null] }
  pendingFrameLayerRef: { current: FrameLayer | null }
  visibleFrameLayerRef: { current: FrameLayer }
}

/**
 * The offscreen layer becomes the visible one, now that the frame on it can be shown.
 *
 * Shared rather than written twice: native reaches it from the `<Image>`'s `onLoad` and the web
 * from its own decode probe, and a flip that only one of them performed is a pane frozen on the
 * frame before it.
 */
export function settleBrowserFrameLayer(refs: BrowserFrameLayerRefs, layer: FrameLayer): void {
  if (refs.pendingFrameLayerRef.current !== layer) {
    return
  }
  refs.pendingFrameLayerRef.current = null
  refs.visibleFrameLayerRef.current = layer
  updateBrowserLayerVisibility(refs.browserLayerRefs.current, layer)
}

/** A frame that will never decode frees the pending slot and leaves the visible layer alone. */
export function abandonBrowserFrameLayer(refs: BrowserFrameLayerRefs, layer: FrameLayer): void {
  if (refs.pendingFrameLayerRef.current === layer) {
    refs.pendingFrameLayerRef.current = null
  }
}
