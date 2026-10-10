import type { Image, View } from 'react-native'
import type { FrameLayer } from './mobile-browser-frame-state'

/** Told when a frame the pane has already handed to a layer is safe to show, or never will be. */
export type BrowserFrameDisplayHandlers = {
  onDisplayable: () => void
  onUndecodable: () => void
}

export function updateBrowserLayerVisibility(
  layers: [View | null, View | null],
  visible: FrameLayer
): void {
  for (const [index, layer] of layers.entries()) {
    layer?.setNativeProps({ style: { opacity: index === visible ? 1 : 0 } })
  }
}

export function updateBrowserImageSource(image: Image | null, uri: string): void {
  // Why: browser frames are large strings; mutating only the native Image
  // source avoids re-rendering the whole tab view for every streamed frame.
  const source = [{ uri }]
  image?.setNativeProps({ source, src: source })
}

/**
 * Native: the rendered `<Image>` decodes the source it was handed and reports it through `onLoad`
 * and `onError`, so the layer flip already has its signal and this owes nothing. The `.web.ts`
 * sibling is where a signal has to be made, because a `background-image` write fires neither.
 */
export function whenBrowserFrameDisplayable(
  _uri: string,
  _handlers: BrowserFrameDisplayHandlers
): void {}
