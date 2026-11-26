import { useEffect, useMemo, useRef, useState } from 'react'
import { Image, StyleSheet, View } from 'react-native'
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import {
  containPanZoomView,
  getFittedPanZoomView,
  getPanZoomFitScale,
  getPanZoomViewOffset,
  panView,
  zoomViewAt,
  type PanZoomPoint,
  type PanZoomSize,
  type PanZoomView
} from '../../../../../src/shared/document-preview/pan-zoom-view'
import type { MobilePanZoomImage } from './MobilePanZoomImage'

export function MobileNativePanZoomImage({
  uri,
  label,
  size,
  upscale = false,
  onError
}: Parameters<typeof MobilePanZoomImage>[0]) {
  const [loaded, setLoaded] = useState<PanZoomSize | null>(null)
  const [viewport, setViewport] = useState<PanZoomSize | null>(null)
  const [manualView, setManualView] = useState<PanZoomView | null>(null)
  const pinchFocus = useRef<PanZoomPoint | null>(null)
  const content = size ?? loaded
  useEffect(() => {
    if (size) {
      return
    }
    let live = true
    void Image.getSize(uri).then(
      (naturalSize) => {
        if (live && naturalSize.width > 0 && naturalSize.height > 0) {
          setLoaded(naturalSize)
        }
      },
      () => {
        if (live) {
          onError?.()
        }
      }
    )
    return () => {
      live = false
    }
  }, [uri, size, onError])
  const geometry = useMemo(
    () =>
      content && viewport && viewport.width > 0 && viewport.height > 0
        ? { content, viewport, fitScale: getPanZoomFitScale(content, viewport, undefined, upscale) }
        : null,
    [content, viewport, upscale]
  )

  const gesture = useMemo(() => {
    const updateView = (update: (view: PanZoomView) => PanZoomView | null): void => {
      if (geometry) {
        setManualView((current) =>
          update(
            current ? containPanZoomView(current, geometry) : getFittedPanZoomView(geometry.content)
          )
        )
      }
    }
    const pinch = Gesture.Pinch()
      .runOnJS(true)
      .enabled(geometry !== null)
      .onStart(({ focalX, focalY }) => {
        pinchFocus.current = { x: focalX, y: focalY }
      })
      .onChange(({ focalX, focalY, scaleChange }) => {
        const target = { x: focalX, y: focalY }
        const anchor = pinchFocus.current ?? target
        pinchFocus.current = target
        if (geometry && scaleChange > 0) {
          updateView((view) =>
            zoomViewAt({
              ...geometry,
              view,
              nextZoom: view.zoom * scaleChange,
              anchor,
              target,
              contain: true
            })
          )
        }
      })
      .onFinalize(() => {
        pinchFocus.current = null
      })
    const pan = Gesture.Pan()
      .runOnJS(true)
      .enabled(geometry !== null)
      .onChange(({ changeX, changeY, numberOfPointers }) => {
        if (geometry && numberOfPointers === 1 && !pinchFocus.current) {
          updateView((view) =>
            panView(
              view,
              { x: changeX, y: changeY },
              geometry.fitScale * view.zoom,
              geometry.content,
              geometry.viewport
            )
          )
        }
      })
    const doubleTap = Gesture.Tap()
      .runOnJS(true)
      .enabled(geometry !== null)
      .numberOfTaps(2)
      .maxDelay(300)
      .maxDistance(10)
      .onEnd(({ x, y }, success) => {
        if (geometry && success) {
          const actual = 1 / geometry.fitScale
          updateView((view) =>
            view.zoom !== 1
              ? null
              : zoomViewAt({
                  ...geometry,
                  view: getFittedPanZoomView(geometry.content),
                  nextZoom: actual > 1.5 ? actual : 2.5,
                  anchor: { x, y },
                  contain: true
                })
          )
        }
      })
    return Gesture.Simultaneous(pinch, pan, doubleTap)
  }, [geometry])

  let imageStyle
  if (geometry) {
    const view = manualView
      ? containPanZoomView(manualView, geometry)
      : getFittedPanZoomView(geometry.content)
    const scale = geometry.fitScale * view.zoom
    const { x, y } = getPanZoomViewOffset(view, geometry.viewport, scale)
    imageStyle = {
      left: x,
      top: y,
      width: geometry.content.width * scale,
      height: geometry.content.height * scale
    }
  }
  return (
    <GestureHandlerRootView style={styles.stage}>
      <GestureDetector gesture={gesture}>
        <View
          style={styles.stage}
          onLayout={({ nativeEvent: { layout } }) => {
            setViewport({ width: layout.width, height: layout.height })
          }}
        >
          {imageStyle ? (
            <Image
              source={{ uri }}
              accessibilityLabel={label}
              resizeMode="contain"
              style={[styles.image, imageStyle]}
              onError={onError}
            />
          ) : null}
        </View>
      </GestureDetector>
    </GestureHandlerRootView>
  )
}

const styles = StyleSheet.create({
  stage: { flex: 1, overflow: 'hidden' },
  image: { position: 'absolute' }
})
