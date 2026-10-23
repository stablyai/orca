import { clipboardFormatsIncludeImage } from '../../shared/clipboard-image'
import {
  readWindowsCopiedImageFilePath,
  type WindowsClipboardFileFormats
} from './clipboard-windows-image-file'

type ClipboardImageReader = {
  availableFormats: () => string[] | Promise<string[]>
  readBuffer: (format: string) => Buffer | Promise<Buffer>
  has: (format: string) => boolean | Promise<boolean>
}

// macOS image data beside a file URL can be omitted from availableFormats().
const MAC_PASTEBOARD_IMAGE_TYPES = ['public.png', 'public.tiff'] as const

type ClipboardImageSource =
  | { kind: 'native'; windowsFileFormats: WindowsClipboardFileFormats | null }
  | { kind: 'windows-file'; windowsFileFormats: WindowsClipboardFileFormats }

/** Select image sources without decoding pixels or reading a copied file. */
export async function readClipboardImageSource(
  clipboard: ClipboardImageReader,
  platform: NodeJS.Platform = process.platform
): Promise<ClipboardImageSource | null> {
  const uriList = platform === 'win32' ? await clipboard.readBuffer('text/uri-list') : null
  const formats =
    platform === 'win32'
      ? {
          ...(uriList?.length ? { uriList } : {}),
          fileNameW: await clipboard.readBuffer('FileNameW'),
          shellIdListArray: await clipboard.readBuffer('Shell IDList Array')
        }
      : null
  const windowsFileFormats = formats && readWindowsCopiedImageFilePath(formats) ? formats : null
  if (clipboardFormatsIncludeImage(await clipboard.availableFormats())) {
    return { kind: 'native', windowsFileFormats }
  }
  if (platform === 'darwin') {
    for (const type of MAC_PASTEBOARD_IMAGE_TYPES) {
      if (await clipboard.has(type)) {
        return { kind: 'native', windowsFileFormats: null }
      }
    }
  }
  return windowsFileFormats ? { kind: 'windows-file', windowsFileFormats } : null
}
