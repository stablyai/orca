import type { NativeImage } from 'electron'

export function encodeNativeImageScreenshot(
  image: NativeImage,
  params: Record<string, unknown> | undefined
): { data: string } | null {
  // The native viewport has no verified scroll/zoom/device-scale mapping to a CDP clip.
  if (params?.clip !== undefined || params?.captureBeyondViewport || image.isEmpty()) {
    return null
  }
  const format = params?.format === 'jpeg' ? 'jpeg' : 'png'
  const quality =
    typeof params?.quality === 'number' && Number.isFinite(params.quality)
      ? Math.max(0, Math.min(100, Math.round(params.quality)))
      : undefined
  const buffer = format === 'jpeg' ? image.toJPEG(quality ?? 90) : image.toPNG()
  return { data: buffer.toString('base64') }
}
