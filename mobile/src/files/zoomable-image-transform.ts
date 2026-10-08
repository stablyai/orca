/**
 * Pinch-zoom math for the file-preview image viewer. Plain functions on
 * purpose: the reanimated babel step bundles them into the gesture worklets,
 * the way drag-reorder-positions rides along with DragReorderList.
 */

/** Matches the maximumZoomScale the iOS-only ScrollView zoom used to allow. */
export const MAX_ZOOMABLE_IMAGE_SCALE = 4

export type ZoomableImageTransform = {
  scale: number
  translateX: number
  translateY: number
}

export function clampZoomableImageScale(scale: number): number {
  return Math.min(MAX_ZOOMABLE_IMAGE_SCALE, Math.max(1, scale))
}

/** A zoomed image pans no further than its own grown edge; scale 1 pins it centered. */
export function clampZoomableImagePan(
  translateX: number,
  translateY: number,
  scale: number,
  imageWidth: number,
  imageHeight: number
): Pick<ZoomableImageTransform, 'translateX' | 'translateY'> {
  if (scale <= 1) {
    return { translateX: 0, translateY: 0 }
  }
  const boundX = ((scale - 1) * imageWidth) / 2
  const boundY = ((scale - 1) * imageHeight) / 2
  return {
    translateX: Math.min(boundX, Math.max(-boundX, translateX)),
    translateY: Math.min(boundY, Math.max(-boundY, translateY))
  }
}

/**
 * The transform that holds the container point under the pinch focal still while
 * the scale changes. A content point's screen position is
 * translate + scale * (point - center), so translate moves opposite the focal by
 * exactly the growth there; the pan clamp then keeps a focal on the padding
 * zooming the image edge instead of dragging the image off frame.
 */
export function zoomableImageFocalTransform(base: {
  scale: number
  scaleRatio: number
  translateX: number
  translateY: number
  focalX: number
  focalY: number
  centerX: number
  centerY: number
  imageWidth: number
  imageHeight: number
}): ZoomableImageTransform {
  const scale = clampZoomableImageScale(base.scale * base.scaleRatio)
  const growth = scale / base.scale
  const translateX = base.translateX * growth + (base.focalX - base.centerX) * (1 - growth)
  const translateY = base.translateY * growth + (base.focalY - base.centerY) * (1 - growth)
  const pan = clampZoomableImagePan(
    translateX,
    translateY,
    scale,
    base.imageWidth,
    base.imageHeight
  )
  return { scale, translateX: pan.translateX, translateY: pan.translateY }
}
