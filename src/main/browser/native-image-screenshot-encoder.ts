import {
  assertBrowserScreenshotEncodedBytes,
  assertBrowserScreenshotGeometry
} from './browser-screenshot-limits'

function applyFallbackClip(
  image: Electron.NativeImage,
  params: Record<string, unknown> | undefined
): Electron.NativeImage | null {
  if (params?.captureBeyondViewport) {
    // Why: capturePage cannot produce pixels outside the currently painted viewport.
    return null
  }

  const clip = params?.clip
  if (!clip || typeof clip !== 'object') {
    return image
  }
  const clipRect = clip as Record<string, unknown>

  const x = typeof clipRect.x === 'number' ? clipRect.x : Number.NaN
  const y = typeof clipRect.y === 'number' ? clipRect.y : Number.NaN
  const width = typeof clipRect.width === 'number' ? clipRect.width : Number.NaN
  const height = typeof clipRect.height === 'number' ? clipRect.height : Number.NaN
  const scale =
    typeof clipRect.scale === 'number' && Number.isFinite(clipRect.scale) && clipRect.scale > 0
      ? clipRect.scale
      : 1

  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return null
  }

  const cropRect = {
    x: Math.round(x * scale),
    y: Math.round(y * scale),
    width: Math.round(width * scale),
    height: Math.round(height * scale)
  }
  assertBrowserScreenshotGeometry(cropRect.width, cropRect.height)
  const imageSize = image.getSize()
  if (
    cropRect.x < 0 ||
    cropRect.y < 0 ||
    cropRect.width <= 0 ||
    cropRect.height <= 0 ||
    cropRect.x + cropRect.width > imageSize.width ||
    cropRect.y + cropRect.height > imageSize.height
  ) {
    return null
  }

  return image.crop(cropRect)
}

export function encodeNativeImageScreenshot(
  image: Electron.NativeImage,
  params: Record<string, unknown> | undefined
): { data: string } | null {
  if (image.isEmpty()) {
    return null
  }

  const clippedImage = applyFallbackClip(image, params)
  if (!clippedImage || clippedImage.isEmpty()) {
    return null
  }
  const clippedSize = clippedImage.getSize()
  assertBrowserScreenshotGeometry(clippedSize.width, clippedSize.height)

  const format = params?.format === 'jpeg' ? 'jpeg' : 'png'
  const quality =
    typeof params?.quality === 'number' && Number.isFinite(params.quality)
      ? Math.max(0, Math.min(100, Math.round(params.quality)))
      : undefined
  const buffer = format === 'jpeg' ? clippedImage.toJPEG(quality ?? 90) : clippedImage.toPNG()
  assertBrowserScreenshotEncodedBytes(buffer.length)
  return { data: buffer.toString('base64') }
}
