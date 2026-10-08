import { useMemo } from 'react'
import { Image, View } from 'react-native'
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'
import { clampZoomableImagePan, zoomableImageFocalTransform } from './zoomable-image-transform'

const SETTLE_SPRING = { damping: 26, stiffness: 320 }
const DOUBLE_TAP_SCALE = 2.5
/** A pinch released this close to 1 snaps home instead of parking at a hair of zoom. */
const RESET_BELOW_SCALE = 1.02

type Props = {
  dataUri: string
  width: number
  height: number
  title: string
  onImageError: () => void
}

/**
 * The pinch-zoom viewer for a previewed image. ScrollView's maximumZoomScale is
 * iOS-only and silently dead on Android, so these gestures are the one zoom
 * path on every platform: pinch to zoom at the focal, pan while zoomed,
 * double-tap to toggle between 1x and 2.5x.
 */
export function MobileZoomableImage({ dataUri, width, height, title, onImageError }: Props) {
  const scale = useSharedValue(1)
  const translateX = useSharedValue(0)
  const translateY = useSharedValue(0)
  const pinchBase = useSharedValue({ scale: 1, translateX: 0, translateY: 0 })
  const panBase = useSharedValue({ translateX: 0, translateY: 0 })
  const containerSize = useSharedValue({ width, height })

  const gesture = useMemo(
    () =>
      Gesture.Simultaneous(
        Gesture.Pinch()
          .onBegin(() => {
            pinchBase.value = {
              scale: scale.value,
              translateX: translateX.value,
              translateY: translateY.value
            }
          })
          .onUpdate((e) => {
            const next = zoomableImageFocalTransform({
              ...pinchBase.value,
              scaleRatio: e.scale,
              focalX: e.focalX,
              focalY: e.focalY,
              centerX: containerSize.value.width / 2,
              centerY: containerSize.value.height / 2,
              imageWidth: width,
              imageHeight: height
            })
            scale.value = next.scale
            translateX.value = next.translateX
            translateY.value = next.translateY
          })
          .onFinalize(() => {
            if (scale.value < RESET_BELOW_SCALE) {
              scale.value = withSpring(1, SETTLE_SPRING)
              translateX.value = withSpring(0, SETTLE_SPRING)
              translateY.value = withSpring(0, SETTLE_SPRING)
            }
          }),
        Gesture.Pan()
          .onBegin(() => {
            panBase.value = { translateX: translateX.value, translateY: translateY.value }
          })
          .onUpdate((e) => {
            if (scale.value <= 1) {
              return
            }
            const next = clampZoomableImagePan(
              panBase.value.translateX + e.translationX,
              panBase.value.translateY + e.translationY,
              scale.value,
              width,
              height
            )
            translateX.value = next.translateX
            translateY.value = next.translateY
          }),
        Gesture.Tap()
          .numberOfTaps(2)
          .onEnd((e) => {
            if (scale.value > 1) {
              scale.value = withSpring(1, SETTLE_SPRING)
              translateX.value = withSpring(0, SETTLE_SPRING)
              translateY.value = withSpring(0, SETTLE_SPRING)
              return
            }
            const next = zoomableImageFocalTransform({
              scale: scale.value,
              scaleRatio: DOUBLE_TAP_SCALE / scale.value,
              translateX: translateX.value,
              translateY: translateY.value,
              focalX: e.x,
              focalY: e.y,
              centerX: containerSize.value.width / 2,
              centerY: containerSize.value.height / 2,
              imageWidth: width,
              imageHeight: height
            })
            scale.value = withSpring(next.scale, SETTLE_SPRING)
            translateX.value = withSpring(next.translateX, SETTLE_SPRING)
            translateY.value = withSpring(next.translateY, SETTLE_SPRING)
          })
      ),
    [containerSize, height, panBase, pinchBase, scale, translateX, translateY, width]
  )

  const zoomStyle = useAnimatedStyle(
    () => ({
      transform: [
        { translateX: translateX.value },
        { translateY: translateY.value },
        { scale: scale.value }
      ]
    }),
    // Why an explicit array: the mobile web bundle runs no Babel, so Reanimated
    // has no __closure and reads the mapper inputs from here alone.
    [scale, translateX, translateY]
  )

  return (
    <GestureHandlerRootView style={styles.imageContainer}>
      <GestureDetector gesture={gesture}>
        <View
          style={styles.imageFrame}
          onLayout={(e) => {
            containerSize.value = {
              width: e.nativeEvent.layout.width,
              height: e.nativeEvent.layout.height
            }
          }}
        >
          <Animated.View style={zoomStyle}>
            <Image
              source={{ uri: dataUri }}
              style={[styles.image, { width, height }]}
              resizeMode="contain"
              onError={onImageError}
              accessibilityLabel={`${title} image`}
            />
          </Animated.View>
        </View>
      </GestureDetector>
    </GestureHandlerRootView>
  )
}
