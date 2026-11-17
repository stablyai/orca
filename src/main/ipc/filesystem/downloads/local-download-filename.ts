const WINDOWS_RESERVED_LOCAL_BASENAME =
  /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9\u00B9\u00B2\u00B3]|lpt[1-9\u00B9\u00B2\u00B3])(?:\..*)?$/i
const LOCAL_FILENAME_REPLACEMENT_CHARS = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])

// Bidi overrides and zero-width characters let `exe.txt` display as `txt.exe` in a save dialog.
const INVISIBLE_FORMAT_CHARS = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g

export function sanitizeLocalDownloadFilename(remoteBasename: string): string {
  const sanitized = Array.from(remoteBasename.replace(INVISIBLE_FORMAT_CHARS, ''), (char) =>
    char.charCodeAt(0) < 32 || LOCAL_FILENAME_REPLACEMENT_CHARS.has(char) ? '_' : char
  )
    .join('')
    .replace(/[. ]+$/g, '')
  if (!sanitized || WINDOWS_RESERVED_LOCAL_BASENAME.test(sanitized)) {
    return 'download'
  }
  return sanitized
}
