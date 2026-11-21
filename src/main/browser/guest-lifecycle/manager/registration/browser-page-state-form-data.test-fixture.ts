const version33 = Buffer.from([33, 0, 0, 0, 0, 0, 0, 0])

/** A page state Chromium would record for a page loaded without a form body. */
export const GET_PAGE_STATE = version33.toString('base64')

/** One recording a urlencoded form body (its content type is stored as UTF-16). */
export const POST_PAGE_STATE = Buffer.concat([
  version33,
  Buffer.from('application/x-www-form-urlencoded', 'utf16le')
]).toString('base64')
