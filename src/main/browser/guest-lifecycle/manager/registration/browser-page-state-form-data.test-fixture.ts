// A pickle: payload size, then version 33, as Chromium writes page state.
function pageState(payload: Buffer): string {
  const header = Buffer.alloc(8)
  header.writeUInt32LE(payload.length + 4, 0)
  header.writeInt32LE(33, 4)
  return Buffer.concat([header, payload]).toString('base64')
}

/** A page state Chromium would record for a page loaded without a form body. */
export const GET_PAGE_STATE = pageState(Buffer.alloc(0))

/** One recording a urlencoded form body (its content type is stored as UTF-16). */
export const POST_PAGE_STATE = pageState(Buffer.from('application/x-www-form-urlencoded', 'utf16le'))
