import { clipboardFormatsIncludeImage } from '../../shared/clipboard-image'
import {
  readWindowsCopiedImageFilePath,
  type WindowsClipboardFileFormats
} from './clipboard-windows-image-file'

type ClipboardImageReader = {
  availableFormats: () => string[]
  readBuffer: (format: string) => Buffer
  has: (format: string) => boolean
}

// macOS image data beside a file URL can be omitted from availableFormats().
const MAC_PASTEBOARD_IMAGE_TYPES = ['public.png', 'public.tiff'] as const

type ClipboardImageSource =
  | { kind: 'native'; windowsFileFormats: WindowsClipboardFileFormats | null }
  | { kind: 'windows-file'; windowsFileFormats: WindowsClipboardFileFormats }

/** Select image sources without decoding pixels or reading a copied file. */
export function readClipboardImageSource(
  clipboard: ClipboardImageReader,
  platform: NodeJS.Platform = process.platform
): ClipboardImageSource | null {
  const formats =
    platform === 'win32'
      ? {
          fileNameW: clipboard.readBuffer('FileNameW'),
          shellIdListArray: clipboard.readBuffer('Shell IDList Array')
        }
      : null
  const windowsFileFormats = formats && readWindowsCopiedImageFilePath(formats) ? formats : null
  if (clipboardFormatsIncludeImage(clipboard.availableFormats())) {
    return { kind: 'native', windowsFileFormats }
  }
  if (platform === 'darwin' && MAC_PASTEBOARD_IMAGE_TYPES.some((type) => clipboard.has(type))) {
    return { kind: 'native', windowsFileFormats: null }
  }
  return windowsFileFormats ? { kind: 'windows-file', windowsFileFormats } : null
}
