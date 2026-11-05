import type { MobileClipboardImageResizer } from './mobile-clipboard-image-downscale'

// Keep PNG output: upload retries measure its base64 size and terminal paste assumes PNG. Browser tests exercise a real raster under the shipped CSP.

const CLIPBOARD_IMAGE_DATA_URL_PREFIX_RE = /^data:image\/[a-z0-9.+-]+;base64,/i
const RESIZED_MIME = 'image/png'

const CLIPBOARD_IMAGE_DECODE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

async function decodeClipboardImage(source: string): Promise<HTMLImageElement> {
  const prefixed = CLIPBOARD_IMAGE_DATA_URL_PREFIX_RE.test(source)
  const candidates = prefixed
    ? [source]
    : CLIPBOARD_IMAGE_DECODE_MIMES.map((mime) => `data:${mime};base64,${source}`)
  let failure: unknown = null
  for (const src of candidates) {
    const image = new Image()
    image.src = src
    try {
      // decode rejects unreadable sources; an onload-only promise could remain pending forever.
      await image.decode()
      return image
    } catch (error) {
      failure = error
    }
  }
  throw failure instanceof Error ? failure : new Error('Failed to encode resized clipboard image')
}

export const resizeMobileClipboardImage: MobileClipboardImageResizer = async (source, target) => {
  const image = await decodeClipboardImage(source)
  const canvas = document.createElement('canvas')
  canvas.width = target.width
  canvas.height = target.height
  const context = canvas.getContext('2d')
  if (context === null) {
    throw new Error('Failed to encode resized clipboard image')
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  const resized = canvas.toDataURL(RESIZED_MIME).replace(CLIPBOARD_IMAGE_DATA_URL_PREFIX_RE, '')
  // Why: empty base64 would pass the downstream base64 check and upload a corrupt image, so fail
  // loudly here instead of silently sending an invalid payload.
  if (resized.length === 0) {
    throw new Error('Failed to encode resized clipboard image')
  }
  // Return dimensions from the encoded canvas so metadata and bytes describe the same raster.
  return { data: resized, width: canvas.width, height: canvas.height }
}
