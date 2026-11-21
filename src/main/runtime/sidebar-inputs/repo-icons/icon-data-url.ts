import { readRasterImageDimensions } from '../../../../shared/file-preview/raster-image-dimensions'
import type { RuntimeDesktopSurface } from '../../construction/runtime-desktop-surface'
import type { FetchedRepoIcon } from './repo-icon-remote-fetch'

export type IconPngEncoder = NonNullable<RuntimeDesktopSurface['encodeRepoIconPng']>

export type IconDataUrlLimits = {
  maxDataUrlLength: number
  /** Largest source edge decoded; bigger images are refused as decode bombs. */
  maxDecodeEdgePx: number
  /** PNG edges tried in order until one fits `maxDataUrlLength`. */
  encodedEdgesPx: readonly number[]
}

function asDataUrl(mimeType: string, bytes: Uint8Array, maxLength: number): string | null {
  const dataUrl = `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`
  return dataUrl.length <= maxLength ? dataUrl : null
}

/**
 * A small data URL for an icon, which a phone page draws even though its shell loads no https
 * image. Without an encoder (orcad) a small image passes through unchanged; null means it can't fit.
 */
export function iconDataUrl(
  image: FetchedRepoIcon,
  limits: IconDataUrlLimits,
  encode: IconPngEncoder | undefined
): string | null {
  const dimensions = readRasterImageDimensions(image.bytes)
  if (
    !dimensions ||
    dimensions.width > limits.maxDecodeEdgePx ||
    dimensions.height > limits.maxDecodeEdgePx
  ) {
    return null
  }
  if (encode) {
    for (const edge of limits.encodedEdgesPx) {
      const png = encode(image.bytes, edge)
      if (!png) {
        break
      }
      const dataUrl = asDataUrl('image/png', png, limits.maxDataUrlLength)
      if (dataUrl) {
        return dataUrl
      }
    }
  }
  // Why pass through when encoding fails: Electron decodes only PNG and JPEG everywhere, and
  // a small GIF, WebP or ICO the phone can draw must not show worse than on orcad.
  return asDataUrl(image.mimeType, image.bytes, limits.maxDataUrlLength)
}
