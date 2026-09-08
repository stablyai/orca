import type { Image, View } from 'react-native'

type NativePropsTarget = { setNativeProps?: (props: Record<string, unknown>) => void }
type DomTarget = { style?: { opacity?: string; backgroundImage?: string } }

/** Toggle a frame layer without re-rendering. Native refs expose `setNativeProps`;
 *  react-native-web refs are DOM nodes, so mutate the style directly. */
export function setBrowserLayerOpacity(layer: View | null, opacity: 0 | 1): void {
  if (!layer) {
    return
  }
  const native = layer as unknown as NativePropsTarget
  if (typeof native.setNativeProps === 'function') {
    native.setNativeProps({ style: { opacity } })
    return
  }
  const dom = layer as unknown as DomTarget
  if (dom.style) {
    dom.style.opacity = String(opacity)
  }
}

/** Swap a frame layer's image without re-rendering. react-native-web paints the
 *  source as a `background-image` on the Image's inner element and mirrors it in a
 *  hidden `<img>`, so both are updated to keep `onLoad` firing per frame. */
export function setBrowserImageUri(image: Image | null, uri: string): void {
  if (!image) {
    return
  }
  const native = image as unknown as NativePropsTarget
  if (typeof native.setNativeProps === 'function') {
    const source = [{ uri }]
    native.setNativeProps({ source, src: source })
    return
  }
  const root = image as unknown as {
    children?: ArrayLike<DomTarget & { tagName?: string; src?: string }>
  }
  for (const child of Array.from(root.children ?? [])) {
    if (child.tagName === 'IMG') {
      child.src = uri
    } else if (child.style && 'backgroundImage' in child.style) {
      child.style.backgroundImage = `url("${uri}")`
    }
  }
}
