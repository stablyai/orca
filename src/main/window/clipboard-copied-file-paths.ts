import { clipboardFilePathsFromUrls, clipboardFilePathsFromUriList } from './clipboard-file-urls'
import { readWindowsCopiedFilePath } from './clipboard-windows-image-file'

type ClipboardFormatReader = { readBuffer: (format: string) => Buffer | Promise<Buffer> }

const FILE_LIST_MAX_BYTES = 256 * 1024
const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"'
}

async function readBoundedText(clipboard: ClipboardFormatReader, format: string): Promise<string> {
  const buffer = await clipboard.readBuffer(format)
  return buffer.byteLength <= FILE_LIST_MAX_BYTES ? buffer.toString('utf8') : ''
}

function decodeXmlText(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|apos|gt|lt|quot));/g,
    (_entity, decimal: string | undefined, hex: string | undefined, name: string | undefined) =>
      decimal
        ? String.fromCodePoint(Number(decimal))
        : hex
          ? String.fromCodePoint(Number.parseInt(hex, 16))
          : XML_ENTITIES[name ?? '']
  )
}

async function readMacCopiedFilePaths(clipboard: ClipboardFormatReader): Promise<string[]> {
  // Finder's legacy filenames plist lists every copied file; public.file-url holds only the first.
  const plist = await readBoundedText(clipboard, 'NSFilenamesPboardType')
  const listed = Array.from(plist.matchAll(/<string>([^<]*)<\/string>/g), (match) =>
    decodeXmlText(match[1])
  )
  if (listed.length > 0) {
    return listed
  }
  const url = (await readBoundedText(clipboard, 'public.file-url')).trim()
  return url ? clipboardFilePathsFromUrls([url], 'darwin') : []
}

/**
 * Paths of the files a file manager copied, so a paste can tell the text that
 * labels them from prompt text. A list it cannot read in full comes back empty.
 */
export async function readClipboardCopiedFilePaths(
  clipboard: ClipboardFormatReader,
  platform: NodeJS.Platform = process.platform
): Promise<string[]> {
  try {
    const uriList = await clipboard.readBuffer('text/uri-list')
    if (uriList.length > 0) {
      return clipboardFilePathsFromUriList(uriList, platform)
    }
    if (platform === 'darwin') {
      return await readMacCopiedFilePaths(clipboard)
    }
    if (platform === 'win32') {
      const filePath = readWindowsCopiedFilePath({
        fileNameW: await clipboard.readBuffer('FileNameW'),
        shellIdListArray: await clipboard.readBuffer('Shell IDList Array')
      })
      return filePath ? [filePath] : []
    }
    return []
  } catch {
    return []
  }
}
