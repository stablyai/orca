import type { MobileClipboardImageResizer } from './mobile-clipboard-image-downscale'

// Keep PNG output: upload retries measure its base64 size and terminal paste assumes PNG. Browser tests exercise a real raster under the shipped CSP.

const CLIPBOARD_IMAGE_DATA_URL_PREFIX_RE = /^data:image\/[a-z0-9.+-]+;base64,/i
const RESIZED_MIME = 'image/png'

export const resizeMobileClipboardImage: MobileClipboardImageResizer = async (source, target) => {
  const base64 = source.replace(CLIPBOARD_IMAGE_DATA_URL_PREFIX_RE, '')
  const image = new Image()
  image.src = `data:${RESIZED_MIME};base64,${base64}`
  // decode rejects unreadable sources; an onload-only promise could remain pending forever.
  await image.decode()
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
