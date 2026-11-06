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
  // Write large frame strings directly to native Image to avoid rerendering whole tab per frame.
  const source = [{ uri }]
  image?.setNativeProps({ source, src: source })
}

// Native Image onLoad/onError already settle layer flip; web background-image writes need an explicit decode probe instead.
export function whenBrowserFrameDisplayable(
  _uri: string,
  _handlers: BrowserFrameDisplayHandlers
): void {}
