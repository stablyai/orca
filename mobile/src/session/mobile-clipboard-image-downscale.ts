/**
 * The target size an oversized clipboard image is redrawn at, and the type of whatever redraws it.
 *
 * A leaf of its own for the reason `mobile-clipboard-image-upload-chunk.ts` is one: this is the
 * arithmetic the resize is measured by, and the module it came from carries the upload path's RPC
 * operations and its logical client. The render check that measures a real raster in a browser
 * wants the arithmetic and none of that.
 */

// Why: PNG bytes don't scale exactly with pixel area, so undershoot the target on
// each pass and let the bounded retry converge instead of distorting in one shot.
const MOBILE_CLIPBOARD_IMAGE_DOWNSCALE_SAFETY = 0.85

export type MobileClipboardImageResizer = (
  source: string,
  target: { width: number; height: number }
) => Promise<{ data: string; width: number; height: number }>

/**
 * Returns the pixel dimensions to resize a clipboard image to so its base64 fits
 * the upload budget, or null when it already fits (or its dimensions are unusable).
 */
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
