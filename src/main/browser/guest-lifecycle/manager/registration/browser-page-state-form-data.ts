/** Whether a history entry's document was a form POST result, from Chromium's own record. */
export type BrowserPageStateFormData = 'form-data' | 'none' | 'unknown'

// Chromium's page state (Electron's base64 `pageState`) is a pickle: a little-endian uint32
// payload size, then an int32 version, then mojo-serialized frame state. Blink keeps the request
// body on the entry only when the document's own request was a POST, however the form was
// submitted or redirected, with its content type as a mojo string16: a uint32 byte size, a uint32
// length, then UTF-16. Matching that whole field (not the text alone) keeps a URL or other text
// that merely contains a content type from counting.
const SUPPORTED_VERSIONS = { min: 26, max: 40 }
const FORM_CONTENT_TYPES = [
  { type: Buffer.from('application/x-www-form-urlencoded', 'utf16le'), exact: true },
  { type: Buffer.from('text/plain', 'utf16le'), exact: true },
  // Followed by its boundary parameter.
  { type: Buffer.from('multipart/form-data', 'utf16le'), exact: false }
]

function holdsContentTypeField(bytes: Buffer): boolean {
  return FORM_CONTENT_TYPES.some(({ type, exact }) => {
    for (let at = bytes.indexOf(type, 8); at !== -1; at = bytes.indexOf(type, at + 2)) {
      if (at < 16) {
        continue
      }
      const size = bytes.readUInt32LE(at - 8)
      const length = bytes.readUInt32LE(at - 4)
      const lengthFits = exact ? length * 2 === type.length : length * 2 >= type.length
      if (lengthFits && size === 8 + length * 2) {
        return true
      }
    }
    return false
  })
}

export function readBrowserPageStateFormData(
  pageState: string | undefined
): BrowserPageStateFormData {
  if (!pageState) {
    return 'unknown'
  }
  const bytes = Buffer.from(pageState, 'base64')
  if (bytes.length < 8 || bytes.readUInt32LE(0) !== bytes.length - 4) {
    return 'unknown'
  }
  const version = bytes.readInt32LE(4)
  if (version < SUPPORTED_VERSIONS.min || version > SUPPORTED_VERSIONS.max) {
    return 'unknown'
  }
  return holdsContentTypeField(bytes) ? 'form-data' : 'none'
}
