import { nativeImage } from 'electron'
import { open } from 'node:fs/promises'
import { clipboardFormatSnapshot } from './clipboard-formats'
import { readClipboardImageSource } from './clipboard-image-source'
import { readClipboardNativeImage } from './clipboard-native-image'
import { encodeClipboardNativeImagePng } from './clipboard-image-png-encode'
import { readWindowsClipboardImageFileAsPng } from './clipboard-windows-image-file'
import { saveGeneratedNoteImage } from './generated-note-image-admission'
import type { SaveClipboardImageAsTempFileArgs } from './clipboard-image-temp-file'

/** The image a save-image request names, saved with `save`: the clipboard's, or a generated notes
 *  image sent as its bytes. Null when the clipboard holds no image. */
export async function saveRequestedClipboardImage(
  args: SaveClipboardImageAsTempFileArgs | undefined,
  save: (png: Buffer) => Promise<string>
): Promise<string | null> {
  // Notes images arrive as bytes, so the user's clipboard is never read or overwritten.
  if (args?.png !== undefined) {
    return saveGeneratedNoteImage(args.png, save)
  }
  const reader = clipboardFormatSnapshot()
  const source = await readClipboardImageSource(reader)
  if (!source) {
    return null
  }
  const image = await readClipboardNativeImage(reader)
  let png: Buffer | null = null
  if (!image.isEmpty()) {
    png = await encodeClipboardNativeImagePng(image)
  } else if (source.windowsFileFormats) {
    png = await readWindowsClipboardImageFileAsPng(source.windowsFileFormats, {
      createImageFromBuffer: (buffer) => nativeImage.createFromBuffer(buffer),
      openFile: (filePath) => open(filePath, 'r')
    })
  }
  return png ? save(png) : null
}
