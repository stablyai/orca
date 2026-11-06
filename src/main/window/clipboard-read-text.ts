import { clipboard } from 'electron'

/**
 * Reads text from the clipboard, with fallbacks for macOS Universal Clipboard (iOS Handoff)
 * where URLs and plain text may be present under `public.url` or `public.plain-text` without
 * `public.utf8-plain-text` (#36930).
 */
export function readClipboardText(type?: 'selection' | 'clipboard'): string {
  const text = type ? clipboard.readText(type) : clipboard.readText()
  if (text || process.platform !== 'darwin' || type === 'selection') {
    return text
  }
  try {
    const plainText =
      (typeof clipboard.read === 'function' ? clipboard.read('public.plain-text') : '') ||
      (typeof clipboard.readBuffer === 'function'
        ? clipboard.readBuffer('public.plain-text').toString('utf8')
        : '')
    if (plainText) {
      return plainText
    }
    const url =
      (typeof clipboard.read === 'function' ? clipboard.read('public.url') : '') ||
      (typeof clipboard.readBuffer === 'function'
        ? clipboard.readBuffer('public.url').toString('utf8')
        : '')
    if (url) {
      return url
    }
  } catch {
    // Best-effort fallbacks; return standard readText result on error.
  }
  return text
}
