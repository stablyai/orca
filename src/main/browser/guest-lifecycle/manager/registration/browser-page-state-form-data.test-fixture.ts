// As Chromium writes page state: a pickle (payload size, version 33) around mojo fields.
function pageState(...fields: Buffer[]): string {
  const payload = Buffer.concat(fields)
  const header = Buffer.alloc(8)
  header.writeUInt32LE(payload.length + 4, 0)
  header.writeInt32LE(33, 4)
  return Buffer.concat([header, payload]).toString('base64')
}

/** A mojo string16: its struct (header, pointer to the next byte), then the UTF-16 array. */
export function string16Field(text: string): Buffer {
  const struct = Buffer.alloc(24)
  struct.writeUInt32LE(16, 0)
  struct.writeBigUInt64LE(8n, 8)
  struct.writeUInt32LE(8 + text.length * 2, 16)
  struct.writeUInt32LE(text.length, 20)
  const padding = Buffer.alloc((8 - ((text.length * 2) % 8)) % 8)
  return Buffer.concat([struct, Buffer.from(text, 'utf16le'), padding])
}

/** A request body struct (header, content type pointer, body pointer, flags) and its content type. */
function bodyField(contentType: string): Buffer {
  const struct = Buffer.alloc(32)
  struct.writeUInt32LE(32, 0)
  struct.writeBigUInt64LE(24n, 8)
  return Buffer.concat([struct, string16Field(contentType)])
}

/** A page Chromium recorded with no form body. */
export const GET_PAGE_STATE = pageState(string16Field('https://example.test/'))

/** One recording a urlencoded form body's content type. */
export const POST_PAGE_STATE = pageState(
  string16Field('https://example.test/result'),
  bodyField('application/x-www-form-urlencoded')
)

/** A GET page whose address merely contains a content type. */
export const GET_PAGE_STATE_NAMING_A_TYPE = pageState(
  string16Field('https://example.test/text/plain')
)

/** A GET page that saved a form control whose value is a content type. */
export const GET_PAGE_STATE_SAVING_A_TYPE = pageState(
  string16Field('https://example.test/'),
  string16Field('text/plain')
)
