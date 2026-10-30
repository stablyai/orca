// Keep resize arithmetic free of upload RPC dependencies so browser raster checks can import it alone.

// Why: PNG bytes don't scale exactly with pixel area, so undershoot the target on
// each pass and let the bounded retry converge instead of distorting in one shot.
const MOBILE_CLIPBOARD_IMAGE_DOWNSCALE_SAFETY = 0.85

export type MobileClipboardImageResizer = (
  source: string,
  target: { width: number; height: number }
) => Promise<{ data: string; width: number; height: number }>

export function computeMobileClipboardImageDownscale(
  base64Length: number,
  width: number,
  height: number,
  maxBase64Length: number
): { width: number; height: number } | null {
  if (base64Length <= maxBase64Length) {
    return null
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null
  }
  const scale = Math.sqrt(maxBase64Length / base64Length) * MOBILE_CLIPBOARD_IMAGE_DOWNSCALE_SAFETY
  const nextWidth = Math.max(1, Math.floor(width * scale))
  const nextHeight = Math.max(1, Math.floor(height * scale))
  // Guard against a no-op shrink (already 1px) so the retry loop can't spin forever.
  if (nextWidth >= width && nextHeight >= height) {
    return null
  }
  return { width: nextWidth, height: nextHeight }
}
