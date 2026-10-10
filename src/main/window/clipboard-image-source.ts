import { clipboardFormatsIncludeImage } from '../../shared/clipboard-image'
import {
  readWindowsCopiedImageFilePath,
  type WindowsClipboardFileFormats
} from './clipboard-windows-image-file'

export type ClipboardImageReader = {
  availableFormats: () => string[]
  readBuffer: (format: string) => Buffer
}

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
  return windowsFileFormats ? { kind: 'windows-file', windowsFileFormats } : null
}
