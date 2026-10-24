import { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import { Gesture, GestureDetector, type NativeGesture } from 'react-native-gesture-handler'
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from 'react-native-reanimated'
import type { NativeChatImageRefBlock } from '../../../src/shared/native-chat-types'
import { MobileNativeChatImage } from './MobileNativeChatImage'
import { styles } from './mobile-native-chat-message-styles'

type Zoom = { scale: number; x: number; y: number }

export function MobileNativeChatZoomableImagePage({
  image,
  width,
  height,
  index,
  pagingGesture,
  onInteractionChange,
  onImageError
}: {
  image: NativeChatImageRefBlock
  width: number
  height: number
  index: number
  pagingGesture: NativeGesture
  onInteractionChange: (index: number, locked: boolean) => void
  onImageError?: () => void
}) {
  const viewport = useRef<View>(null)
  const origin = useSharedValue({ x: 0, y: 0 })
  const zoom = useSharedValue<Zoom>({ scale: 1, x: 0, y: 0 })
  const pinchBase = useSharedValue<Zoom>({ scale: 1, x: 0, y: 0 })
  const panBase = useSharedValue<Zoom>({ scale: 1, x: 0, y: 0 })
  const panOrigin = useSharedValue({ x: 0, y: 0 })
  const pinching = useSharedValue(false)
  const panSuspended = useSharedValue(false)
  const anchor = useSharedValue({ x: 0, y: 0 })
  const size = useSharedValue({ width, height: 0 })
  const aspect = useSharedValue(0)
  const [zoomed, setZoomed] = useState(false)
  useEffect(() => () => onInteractionChange(index, false), [index, onInteractionChange])

  function constrain(next: Zoom): Zoom {
    'worklet'
    if (next.scale === 1) {
      return { scale: 1, x: 0, y: 0 }
    }
    const { width: w, height: h } = size.value
    const fitWidth = aspect.value > 0 ? Math.min(w, h * aspect.value) : w
    const fitHeight = aspect.value > 0 ? Math.min(h, w / aspect.value) : h
    const maxX = Math.max(0, (fitWidth * next.scale - w) / 2)
    const maxY = Math.max(0, (fitHeight * next.scale - h) / 2)
    return {
      scale: next.scale,
      x: Math.max(-maxX, Math.min(maxX, next.x)),
      y: Math.max(-maxY, Math.min(maxY, next.y))
    }
  }

  const pinch = Gesture.Pinch()
    .runOnJS(true)
    .blocksExternalGesture(pagingGesture)
    .onStart((event) => {
      // Web focal coordinates include the header and side insets.
      const element = viewport.current
      const bounds =
        typeof HTMLElement !== 'undefined' && element instanceof HTMLElement
          ? element.getBoundingClientRect()
          : null
      origin.value = { x: bounds?.left ?? 0, y: bounds?.top ?? 0 }
      pinching.value = true
      panSuspended.value = true
      pinchBase.value = zoom.value
      anchor.value = {
        x: (event.focalX - origin.value.x - size.value.width / 2 - zoom.value.x) / zoom.value.scale,
        y: (event.focalY - origin.value.y - size.value.height / 2 - zoom.value.y) / zoom.value.scale
      }
      runOnJS(onInteractionChange)(index, true)
    })
    .onUpdate((event) => {
      const scale = Math.max(1, Math.min(4, pinchBase.value.scale * event.scale))
      zoom.value = constrain({
        scale,
        x: event.focalX - origin.value.x - size.value.width / 2 - anchor.value.x * scale,
        y: event.focalY - origin.value.y - size.value.height / 2 - anchor.value.y * scale
      })
    })
    .onFinalize(() => {
      pinching.value = false
      const enlarged = zoom.value.scale > 1
      runOnJS(setZoomed)(enlarged)
      runOnJS(onInteractionChange)(index, enlarged)
    })
  const pan = Gesture.Pan()
    .enabled(zoomed)
    .maxPointers(1)
    .blocksExternalGesture(pagingGesture)
    .onStart(() => {
      panSuspended.value = pinching.value
      if (!pinching.value) {
        panBase.value = zoom.value
        panOrigin.value = { x: 0, y: 0 }
      }
    })
    .onUpdate((event) => {
      if (pinching.value || event.numberOfPointers !== 1) {
        return
      }
      if (panSuspended.value) {
        panBase.value = zoom.value
        panOrigin.value = { x: event.translationX, y: event.translationY }
        panSuspended.value = false
        return
      }
      zoom.value = constrain({
        scale: zoom.value.scale,
        x: panBase.value.x + event.translationX - panOrigin.value.x,
        y: panBase.value.y + event.translationY - panOrigin.value.y
      })
    })
  const transform = useAnimatedStyle(
    () => ({
      transform: [
        { translateX: zoom.value.x },
        { translateY: zoom.value.y },
        { scale: zoom.value.scale }
      ]
    }),
    [zoom]
  )
  return (
    <GestureDetector
      gesture={Gesture.Simultaneous(pinch, pan)}
      touchAction={zoomed ? 'none' : 'pan-x'}
    >
      <View
        ref={viewport}
        style={{ width, height, overflow: 'hidden' }}
        onLayout={(event) => {
          size.value = event.nativeEvent.layout
        }}
      >
        <Animated.View style={[{ flex: 1 }, transform]}>
          <MobileNativeChatImage
            uri={image.url ?? image.path}
            alt={image.alt}
            fontScale={1}
            onError={onImageError}
            imageStyle={styles.imageGalleryFill}
            onLoad={(event) => {
              const source = event.nativeEvent.source
              const target = 'target' in event.nativeEvent ? event.nativeEvent.target : null
              const webImage =
                typeof HTMLImageElement !== 'undefined' && target instanceof HTMLImageElement
                  ? target
                  : null
              const w = source?.width ?? webImage?.naturalWidth ?? 0
              const h = source?.height ?? webImage?.naturalHeight ?? 0
              aspect.value = w > 0 && h > 0 ? w / h : 0
            }}
          />
        </Animated.View>
      </View>
    </GestureDetector>
  )
}
