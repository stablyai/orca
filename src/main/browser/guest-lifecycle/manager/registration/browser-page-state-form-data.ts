/** Whether a history entry's document was a form POST result, from Chromium's own record. */
export type BrowserPageStateFormData = 'form-data' | 'none' | 'unknown'

// Chromium's page state (Electron's base64 `pageState`) is a pickle: a little-endian uint32
// payload size, then an int32 version, then mojo-serialized frame state. Blink keeps the request
// body on the entry only when the document's own request was a POST, however the form was
// submitted or redirected. Its content type is the first field of the body struct, so it is
// matched with what mojo writes before it: that 32-byte struct (header, a pointer 24 bytes on to
// the content type), the string16 struct (header, a pointer to the next byte), then the UTF-16
// array (byte size, length). That keeps a URL or a saved form control value from counting.
const SUPPORTED_VERSIONS = { min: 26, max: 40 }
const FORM_CONTENT_TYPES = [
  { type: Buffer.from('application/x-www-form-urlencoded', 'utf16le'), exact: true },
  { type: Buffer.from('text/plain', 'utf16le'), exact: true },
  // Followed by its boundary parameter.
  { type: Buffer.from('multipart/form-data', 'utf16le'), exact: false }
]
const BODY_PREFIX_BYTES = 56

function isBodyContentTypeField(bytes: Buffer, at: number, length: number): boolean {
  const body = at - BODY_PREFIX_BYTES
  const text = at - 24
  return (
    bytes.readUInt32LE(body) === 32 &&
    bytes.readUInt32LE(body + 4) === 0 &&
    bytes.readBigUInt64LE(body + 8) === 24n &&
    bytes.readUInt32LE(text) === 16 &&
    bytes.readUInt32LE(text + 4) === 0 &&
    bytes.readBigUInt64LE(text + 8) === 8n &&
    bytes.readUInt32LE(at - 8) === 8 + length * 2
  )
}

function holdsContentTypeField(bytes: Buffer): boolean {
  return FORM_CONTENT_TYPES.some(({ type, exact }) => {
    for (let at = bytes.indexOf(type, 8); at !== -1; at = bytes.indexOf(type, at + 2)) {
      if (at < 8 + BODY_PREFIX_BYTES) {
        continue
      }
      const length = bytes.readUInt32LE(at - 4)
      const lengthFits = exact ? length * 2 === type.length : length * 2 >= type.length
      if (lengthFits && isBodyContentTypeField(bytes, at, length)) {
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

/** The current history entry's form data; unknown until the page commits or once it is gone. */
export function readBrowserGuestCurrentFormData(
  guest: Electron.WebContents
): BrowserPageStateFormData {
  try {
    const history = guest.navigationHistory
    return readBrowserPageStateFormData(
      history.getEntryAtIndex(history.getActiveIndex())?.pageState
    )
  } catch {
    // A destroyed guest throws; unknown keeps the page, and never breaks a navigation handler.
    return 'unknown'
  }
}
