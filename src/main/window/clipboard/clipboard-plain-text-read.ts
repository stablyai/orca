import { readClipboardCopiedFilePaths } from './clipboard-copied-file-paths'
import { readClipboardImageSource } from './clipboard-image-source'

type ClipboardTextReader = {
  readText: () => string
  availableFormats: () => string[]
  readBuffer: (format: string) => Buffer
  has: (format: string) => boolean
}

// Universal Clipboard URLs can omit public.utf8-plain-text, the only type readText() sees on macOS.
const MAC_TEXT_FALLBACK_TYPES = ['public.plain-text', 'public.url'] as const

function decodeUtf8Text(buffer: Buffer): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    return text.includes('\0') ? '' : text
  } catch {
    return ''
  }
}

export function readClipboardPlainText(
  clipboard: ClipboardTextReader,
  platform: NodeJS.Platform = process.platform
): string {
  const text = clipboard.readText()
  if (text || platform !== 'darwin') {
    return text
  }
  // A copied image or file can carry a source URL; paste must keep treating it as an image or file.
  if (
    readClipboardImageSource(clipboard, platform) ||
    readClipboardCopiedFilePaths(clipboard, platform).length > 0
  ) {
    return ''
  }
  for (const type of MAC_TEXT_FALLBACK_TYPES) {
    const fallback = decodeUtf8Text(clipboard.readBuffer(type))
    if (fallback) {
      return fallback
    }
  }
  return ''
}
