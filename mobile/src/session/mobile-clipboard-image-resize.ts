import { File as FsFile, Paths } from 'expo-file-system'
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import type { MobileClipboardImageResizer } from './mobile-clipboard-image-downscale'

/**
 * Shrinking a clipboard image on a phone, moved out of the paste hook so the page can answer the
 * same contract with a `<canvas>`.
 *
 * Unchanged from where it lived: `expo-image-manipulator` is a native module and both of the
 * `expo-file-system` reads here are the temp file it needs, neither of which a browser has.
 */
const CLIPBOARD_IMAGE_DATA_URL_PREFIX_RE = /^data:image\/[a-z0-9.+-]+;base64,/i

// Why: clipboard images are re-encoded as lossless PNG, so high-res screenshots and
// photos can exceed the upload byte budget; resize the raster down to fit before upload.
// The iOS ImageManipulator loader cannot decode large base64 data URIs, so use a file.
export const resizeMobileClipboardImage: MobileClipboardImageResizer = async (source, target) => {
  const base64 = source.replace(CLIPBOARD_IMAGE_DATA_URL_PREFIX_RE, '')
  const file = new FsFile(Paths.cache, `orca-clip-resize-${Date.now()}.png`)
  let context: ReturnType<typeof ImageManipulator.manipulate> | null = null
  let rendered: Awaited<
    ReturnType<ReturnType<typeof ImageManipulator.manipulate>['renderAsync']>
  > | null = null
  let resultUri: string | null = null
  try {
    file.create({ overwrite: true })
    file.write(base64, { encoding: 'base64' })
    context = ImageManipulator.manipulate(file.uri)
    context.resize({ width: target.width, height: target.height })
    rendered = await context.renderAsync()
    const result = await rendered.saveAsync({ format: SaveFormat.PNG, base64: true })
    resultUri = result.uri
    // Why: empty base64 would pass the downstream base64 check and upload a corrupt
    // image, so fail loudly here instead of silently sending an invalid payload.
    if (!result.base64) {
      throw new Error('Failed to encode resized clipboard image')
    }
    return { data: result.base64, width: result.width, height: result.height }
  } finally {
    rendered?.release()
    context?.release()
    if (resultUri) {
      try {
        new FsFile(resultUri).delete()
      } catch {
        // Best-effort cleanup; ImageManipulator saves into cache for every retry.
      }
    }
    try {
      file.delete()
    } catch {
      // Best-effort cleanup; the OS reclaims the cache directory regardless.
    }
  }
}
