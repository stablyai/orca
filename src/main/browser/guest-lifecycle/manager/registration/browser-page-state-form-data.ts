/** Whether a history entry's document was a form POST result, from Chromium's own record. */
export type BrowserPageStateFormData = 'form-data' | 'none' | 'unknown'

// Chromium's page state (Electron's base64 `pageState`) starts with a little-endian int32
// version. Blink keeps the request body, and its content type as UTF-16, on the entry only when
// the document's own request was a POST, however the form was submitted or redirected.
const SUPPORTED_VERSIONS = { min: 26, max: 40 }
const FORM_CONTENT_TYPES = [
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain'
].map((type) => Buffer.from(type, 'utf16le'))

export function readBrowserPageStateFormData(
  pageState: string | undefined
): BrowserPageStateFormData {
  if (!pageState) {
    return 'unknown'
  }
  let bytes: Buffer
  try {
    bytes = Buffer.from(pageState, 'base64')
  } catch {
    return 'unknown'
  }
  if (bytes.length < 8) {
    return 'unknown'
  }
  const version = bytes.readInt32LE(0)
  if (version < SUPPORTED_VERSIONS.min || version > SUPPORTED_VERSIONS.max) {
    return 'unknown'
  }
  return FORM_CONTENT_TYPES.some((type) => bytes.includes(type)) ? 'form-data' : 'none'
}

/** The active entry's record; 'unknown' when the history can't be read. */
export function readBrowserGuestActiveEntryFormData(
  guest: Electron.WebContents
): BrowserPageStateFormData {
  try {
    const history = guest.navigationHistory
    return readBrowserPageStateFormData(
      history.getEntryAtIndex(history.getActiveIndex())?.pageState
    )
  } catch {
    return 'unknown'
  }
}
