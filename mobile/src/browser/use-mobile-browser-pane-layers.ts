import { useCallback } from 'react'
import type { Image, View } from 'react-native'
import {
  updateBrowserImageSource,
  updateBrowserLayerVisibility,
  type FrameLayer
} from './mobile-browser-frame-state'
import { mobileBrowserPaneStyles as styles } from './mobile-browser-pane-styles'

type BrowserLayerHandlersArgs = {
  browserImageRefs: { current: [Image | null, Image | null] }
  browserLayerRefs: { current: [View | null, View | null] }
  frameUriRef: { current: string | null }
  pendingFrameLayerRef: { current: FrameLayer | null }
  visibleFrameLayerRef: { current: FrameLayer }
}

export function useMobileBrowserPaneLayers(args: BrowserLayerHandlersArgs) {
  const {
    browserImageRefs,
    browserLayerRefs,
    frameUriRef,
    pendingFrameLayerRef,
    visibleFrameLayerRef
  } = args

  const setBrowserImageRef = useCallback(
    (layer: FrameLayer, image: Image | null) => {
      browserImageRefs.current[layer] = image
      const currentFrameUri = frameUriRef.current
      if (image && currentFrameUri) {
        updateBrowserImageSource(image, currentFrameUri)
      }
    },
    [browserImageRefs, frameUriRef]
  )

  const setBrowserLayerRef = useCallback(
    (layer: FrameLayer, view: View | null) => {
      browserLayerRefs.current[layer] = view
      updateBrowserLayerVisibility(browserLayerRefs.current, visibleFrameLayerRef.current)
    },
    [browserLayerRefs, visibleFrameLayerRef]
  )

  const setBrowserLayer0Ref = useCallback(
    (view: View | null) => setBrowserLayerRef(0, view),
    [setBrowserLayerRef]
  )
  const setBrowserLayer1Ref = useCallback(
    (view: View | null) => setBrowserLayerRef(1, view),
    [setBrowserLayerRef]
  )
  const setBrowserImageLayer0Ref = useCallback(
    (image: Image | null) => setBrowserImageRef(0, image),
    [setBrowserImageRef]
  )
  const setBrowserImageLayer1Ref = useCallback(
    (image: Image | null) => setBrowserImageRef(1, image),
    [setBrowserImageRef]
  )

  const handleBrowserImageLoad = useCallback(
    (layer: FrameLayer) => {
      if (pendingFrameLayerRef.current !== layer) {
        return
      }
      pendingFrameLayerRef.current = null
      visibleFrameLayerRef.current = layer
      updateBrowserLayerVisibility(browserLayerRefs.current, layer)
    },
    [browserLayerRefs, pendingFrameLayerRef, visibleFrameLayerRef]
  )

  const handleBrowserImageLayer0Load = useCallback(
    () => handleBrowserImageLoad(0),
    [handleBrowserImageLoad]
  )
  const handleBrowserImageLayer1Load = useCallback(
    () => handleBrowserImageLoad(1),
    [handleBrowserImageLoad]
  )

  const handleBrowserImageError = useCallback(
    (layer: FrameLayer) => {
      if (pendingFrameLayerRef.current === layer) {
        pendingFrameLayerRef.current = null
      }
    },
    [pendingFrameLayerRef]
  )

  const handleBrowserImageLayer0Error = useCallback(
    () => handleBrowserImageError(0),
    [handleBrowserImageError]
  )
  const handleBrowserImageLayer1Error = useCallback(
    () => handleBrowserImageError(1),
    [handleBrowserImageError]
  )

  const frameLayerStyle = useCallback(
    (layer: FrameLayer) => {
      return [
        styles.browserImageLayer,
        visibleFrameLayerRef.current !== layer && styles.browserImageLayerHidden
      ]
    },
    [visibleFrameLayerRef]
  )

  const browserLayerRef = useCallback(
    (layer: FrameLayer) => (layer === 0 ? setBrowserLayer0Ref : setBrowserLayer1Ref),
    [setBrowserLayer0Ref, setBrowserLayer1Ref]
  )

  const frameLayerRef = useCallback(
    (layer: FrameLayer) => (layer === 0 ? setBrowserImageLayer0Ref : setBrowserImageLayer1Ref),
    [setBrowserImageLayer0Ref, setBrowserImageLayer1Ref]
  )

  const frameLayerLoadHandler = useCallback(
    (layer: FrameLayer) =>
      layer === 0 ? handleBrowserImageLayer0Load : handleBrowserImageLayer1Load,
    [handleBrowserImageLayer0Load, handleBrowserImageLayer1Load]
  )

  const frameLayerErrorHandler = useCallback(
    (layer: FrameLayer) =>
      layer === 0 ? handleBrowserImageLayer0Error : handleBrowserImageLayer1Error,
    [handleBrowserImageLayer0Error, handleBrowserImageLayer1Error]
  )

  return {
    browserLayerRef,
    frameLayerErrorHandler,
    frameLayerLoadHandler,
    frameLayerRef,
    frameLayerStyle
  }
}
