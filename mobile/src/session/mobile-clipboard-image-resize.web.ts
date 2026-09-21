import type { MobileClipboardImageResizer } from './mobile-clipboard-image-downscale'

/**
 * Web sibling: the raster shrink as a `<canvas>` draw, which is the one thing the page can do that
 * the native path needed a module and two file writes for.
 *
 * `expo-image-manipulator` is a native module with no browser counterpart, and the temp file its
 * native path writes exists to work around a loader that cannot decode a large base64 data URI —
 * a constraint a browser does not have. The shell's `img-src 'self' data:` admits the source, so
 * the decode is one `<img>` and the encode is `toDataURL`, with no file anywhere in it.
 *
 * PNG out, as before: the caller's downscale loop measures base64 length and retries, so a format
 * that compressed differently would converge somewhere else, and the terminal paste that follows
 * assumes PNG.
 *
 * Proved in `mobile-web-app-clipboard-image-resize-render.test.mjs`, in a real browser under the
 * shipped policy against a real PNG, because a fake canvas cannot answer what a raster weighs.
 */

const CLIPBOARD_IMAGE_DATA_URL_PREFIX_RE = /^data:image\/[a-z0-9.+-]+;base64,/i
const RESIZED_MIME = 'image/png'

export const resizeMobileClipboardImage: MobileClipboardImageResizer = async (source, target) => {
  const base64 = source.replace(CLIPBOARD_IMAGE_DATA_URL_PREFIX_RE, '')
  const image = new Image()
  image.src = `data:${RESIZED_MIME};base64,${base64}`
  // `decode()` rather than an `onload` race: it rejects on a source the browser cannot read, where
  // `onload` would simply never fire and leave the paste waiting on a promise nothing settles.
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
  // loudly here instead of silently sending an invalid payload — the native path's own rule.
  if (resized.length === 0) {
    throw new Error('Failed to encode resized clipboard image')
  }
  // Read back off the canvas rather than echoed from `target`. The two are the same number today,
  // because a browser reflects the width it was assigned; the point is that the size and the bytes
  // come from one element, so a caller's bookkeeping cannot describe a raster that was not encoded.
  return { data: resized, width: canvas.width, height: canvas.height }
}
