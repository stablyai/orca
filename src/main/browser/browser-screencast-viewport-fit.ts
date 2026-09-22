import type { NativeImage } from 'electron'
import type {
  BrowserScreencastOptions,
  ScreencastImageSize
} from './browser-screencast-stream-types'

function isNear(value: number, expected: number): boolean {
  return Math.abs(value - expected) <= Math.max(2, expected * 0.02)
}

function scaleToFit(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number
): {
  width: number
  height: number
} {
  const scale = Math.min(1, maxWidth / width, maxHeight / height)
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale)
  }
}

// Why: capturePage returns device pixels, so a hi-DPI viewport yields a bitmap several times
// larger than the live path is allowed to send. Apply the caller's cap here too.
export function scaleSnapshotToFit(
  image: NativeImage,
  options: BrowserScreencastOptions
): NativeImage {
  const size = image.getSize()
  if (!size.width || !size.height) {
    return image
  }
  const fitted = scaleToFit(size.width, size.height, options.maxWidth, options.maxHeight)
  if (fitted.width === size.width && fitted.height === size.height) {
    return image
  }
  return image.resize(fitted)
}

function isNearSize(
  actual: { width: number; height: number },
  expected: { width: number; height: number }
): boolean {
  return isNear(actual.width, expected.width) && isNear(actual.height, expected.height)
}

export function isLiveFrameCompatibleWithViewport(
  imageSize: ScreencastImageSize | null,
  options: BrowserScreencastOptions
): boolean {
  const viewportWidth = positiveInteger(options.viewportWidth)
  const viewportHeight = positiveInteger(options.viewportHeight)
  if (!viewportWidth || !viewportHeight) {
    return true
  }
  if (!imageSize) {
    return true
  }
  const deviceScaleFactor = positiveNumber(options.deviceScaleFactor) ?? 1
  const cssViewport = { width: viewportWidth, height: viewportHeight }
  const deviceViewport = {
    width: Math.round(viewportWidth * deviceScaleFactor),
    height: Math.round(viewportHeight * deviceScaleFactor)
  }
  const scaledDeviceViewport = scaleToFit(
    deviceViewport.width,
    deviceViewport.height,
    options.maxWidth,
    options.maxHeight
  )
  // Why: Chromium can stream CSS-sized, DPR-sized, or maxWidth/maxHeight-scaled
  // bitmaps for the same emulated viewport. All are client-authoritative; stale
  // host BrowserView frames are the incompatible ones we need to drop.
  return (
    isNearSize(imageSize, cssViewport) ||
    isNearSize(imageSize, deviceViewport) ||
    isNearSize(imageSize, scaledDeviceViewport)
  )
}

export function positiveInteger(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null
}

export function positiveNumber(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}
