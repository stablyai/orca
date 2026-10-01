import { fileURLToPath } from 'node:url'
import { readWindowsCopiedFilePath } from './clipboard-windows-image-file'

type ClipboardFormatReader = { readBuffer: (format: string) => Buffer }

const FILE_LIST_MAX_BYTES = 256 * 1024
const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"'
}

function readBoundedText(clipboard: ClipboardFormatReader, format: string): string {
  const buffer = clipboard.readBuffer(format)
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

/** macOS/Linux file URLs; any other entry means this is not a file copy. */
function filePathsFromUrls(urls: readonly string[]): string[] {
  const paths: string[] = []
  for (const url of urls) {
    // Finder can hand out file-reference URLs (/.file/id=…), which name no file.
    if (!url.startsWith('file://') || url.startsWith('file:///.file/id=')) {
      return []
    }
    paths.push(fileURLToPath(url, { windows: false }))
  }
  return paths
}

function readMacCopiedFilePaths(clipboard: ClipboardFormatReader): string[] {
  // Finder's legacy filenames plist lists every copied file; public.file-url holds only the first.
  const plist = readBoundedText(clipboard, 'NSFilenamesPboardType')
  const listed = Array.from(plist.matchAll(/<string>([^<]*)<\/string>/g), (match) =>
    decodeXmlText(match[1])
  )
  if (listed.length > 0) {
    return listed
  }
  const url = readBoundedText(clipboard, 'public.file-url').trim()
  return url ? filePathsFromUrls([url]) : []
}

function readLinuxCopiedFilePaths(clipboard: ClipboardFormatReader): string[] {
  const urls = readBoundedText(clipboard, 'text/uri-list')
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  return filePathsFromUrls(urls)
}

/**
 * Paths of the files a file manager copied, so a paste can tell the text that
 * labels them from prompt text. A list it cannot read in full comes back empty.
 */
export function readClipboardCopiedFilePaths(
  clipboard: ClipboardFormatReader,
  platform: NodeJS.Platform = process.platform
): string[] {
  try {
    if (platform === 'darwin') {
      return readMacCopiedFilePaths(clipboard)
    }
    if (platform === 'win32') {
      const filePath = readWindowsCopiedFilePath({
        fileNameW: clipboard.readBuffer('FileNameW'),
        shellIdListArray: clipboard.readBuffer('Shell IDList Array')
      })
      return filePath ? [filePath] : []
    }
    return readLinuxCopiedFilePaths(clipboard)
  } catch {
    return []
  }
}
