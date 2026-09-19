import { fileUriToFilesystemPath } from '../../shared/file-uri-path'
import {
  decodeWindowsClipboardFilePath,
  isWindowsClipboardImageFile
} from './clipboard-windows-image-file'

// Injected so the platform branching is unit-testable without the real OS clipboard.
export type ClipboardFileReadDeps = {
  platform: NodeJS.Platform
  readBuffer: (format: string) => Buffer
}

const PLIST_STRING_RE = /<string>([^<]*)<\/string>/g
const XML_ENTITY_RE = /&(amp|lt|gt|quot|apos);/g
const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'"
}

// Counterpart of writeFileToClipboard: read the file references a file-manager
// copy (Finder / Explorer / Nautilus) leaves on the clipboard. Their text flavor
// is only the display name, so the path has to come from the OS file flavor.
// Returns [] when the clipboard holds no file reference and never throws.
export function readClipboardFilePaths(deps: ClipboardFileReadDeps): string[] {
  const readBuffer = (format: string): Buffer => {
    try {
      return deps.readBuffer(format)
    } catch {
      return Buffer.alloc(0)
    }
  }
  const readUtf8 = (format: string): string => readBuffer(format).toString('utf8')

  if (deps.platform === 'darwin') {
    // Why: NSFilenamesPboardType lists every copied path; public.file-url only the first.
    const listedPaths = [...readUtf8('NSFilenamesPboardType').matchAll(PLIST_STRING_RE)]
      .map(([, value]) => value.replace(XML_ENTITY_RE, (entity) => XML_ENTITIES[entity]))
      .filter(Boolean)
    return listedPaths.length > 0 ? listedPaths : fileUrisToPaths([readUtf8('public.file-url')])
  }

  if (deps.platform === 'win32') {
    const filePath = decodeWindowsClipboardFilePath({
      fileNameW: readBuffer('FileNameW'),
      shellIdListArray: readBuffer('Shell IDList Array')
    })
    // Why: Explorer-copied PNG/JPEG files keep the clipboard image attachment flow (#9640).
    return filePath && !isWindowsClipboardImageFile(filePath) ? [filePath] : []
  }

  return fileUrisToPaths(readUtf8('text/uri-list').split(/\r?\n/))
}

function fileUrisToPaths(uris: string[]): string[] {
  const paths: string[] = []
  for (const uri of uris) {
    const trimmed = uri.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }
    try {
      const filePath = fileUriToFilesystemPath(new URL(trimmed))
      if (filePath) {
        paths.push(filePath)
      }
    } catch {
      // not a URL
    }
  }
  return paths
}
