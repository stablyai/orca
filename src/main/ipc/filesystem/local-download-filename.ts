const WINDOWS_RESERVED_LOCAL_BASENAME =
  /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9\u00B9\u00B2\u00B3]|lpt[1-9\u00B9\u00B2\u00B3])(?:\..*)?$/i
const LOCAL_FILENAME_REPLACEMENT_CHARS = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])

export function sanitizeLocalDownloadFilename(remoteBasename: string): string {
  const sanitized = Array.from(remoteBasename, (char) =>
    char.charCodeAt(0) < 32 || LOCAL_FILENAME_REPLACEMENT_CHARS.has(char) ? '_' : char
  )
    .join('')
    .replace(/[. ]+$/g, '')
  if (!sanitized || WINDOWS_RESERVED_LOCAL_BASENAME.test(sanitized)) {
    return 'download'
  }
  return sanitized
}
