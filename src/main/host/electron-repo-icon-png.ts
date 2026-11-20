import { nativeImage, type NativeImage } from 'electron'

function fitWithinEdge(image: NativeImage, maxEdge: number): NativeImage {
  const { width, height } = image.getSize()
  const scale = Math.min(1, maxEdge / Math.max(width, height))
  return scale < 1
    ? image.resize({
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        quality: 'best'
      })
    : image
}

function decodeRepoIcon(bytes: Uint8Array): NativeImage | null {
  const image = nativeImage.createFromBuffer(Buffer.from(bytes))
  const { width, height } = image.getSize()
  return image.isEmpty() || width <= 0 || height <= 0 ? null : image
}

function pngWithinLimit(image: NativeImage, maxBytes: number): Uint8Array | null {
  const png = image.toPNG()
  return png.byteLength > 0 && png.byteLength <= maxBytes ? png : null
}

/** Re-encode as PNG within maxEdge without upscaling. */
export function encodeRepoIconPng(bytes: Uint8Array, maxEdge: number): Uint8Array | null {
  try {
    const image = decodeRepoIcon(bytes)
    return image ? pngWithinLimit(fitWithinEdge(image, maxEdge), Number.POSITIVE_INFINITY) : null
  } catch {
    return null
  }
}

const FITTING_EDGES_PX = [512, 384, 256, 192, 128, 96, 64, 48, 32] as const

/** Lossless PNG downscale chain: the first edge whose encoded PNG fits the storage limit wins. */
export function encodeRepoIconPngWithinLimit(
  bytes: Uint8Array,
  maxBytes: number
): { bytes: Uint8Array; width: number; height: number } | null {
  try {
    const image = decodeRepoIcon(bytes)
    if (!image) {
      return null
    }
    for (const edge of FITTING_EDGES_PX) {
      const fitted = fitWithinEdge(image, edge)
      const png = pngWithinLimit(fitted, maxBytes)
      if (png) {
        const { width, height } = fitted.getSize()
        return { bytes: png, width, height }
      }
    }
    return null
  } catch {
    return null
  }
}
