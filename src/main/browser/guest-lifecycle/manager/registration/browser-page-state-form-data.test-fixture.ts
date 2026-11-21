// As Chromium writes page state: a pickle (payload size, version 33) around mojo fields.
function pageState(...fields: Buffer[]): string {
  const payload = Buffer.concat(fields)
  const header = Buffer.alloc(8)
  header.writeUInt32LE(payload.length + 4, 0)
  header.writeInt32LE(33, 4)
  return Buffer.concat([header, payload]).toString('base64')
}

/** A mojo string16 field: byte size, length, then UTF-16. */
export function string16Field(text: string): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32LE(8 + text.length * 2, 0)
  header.writeUInt32LE(text.length, 4)
  return Buffer.concat([header, Buffer.from(text, 'utf16le')])
}

/** A page Chromium recorded with no form body. */
export const GET_PAGE_STATE = pageState(string16Field('https://example.test/'))

/** One recording a urlencoded form body's content type. */
export const POST_PAGE_STATE = pageState(
  string16Field('https://example.test/result'),
  string16Field('application/x-www-form-urlencoded')
)

/** A GET page whose address merely contains a content type. */
export const GET_PAGE_STATE_NAMING_A_TYPE = pageState(
  string16Field('https://example.test/text/plain')
)
