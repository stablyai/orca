/** An opaque cursor: a versioned prefix over its payload as base64url JSON. */
export function encodeVersionedJsonCursor(prefix: string, payload: unknown): string {
  return `${prefix}${Buffer.from(JSON.stringify(payload)).toString('base64url')}`
}

/** The payload of a cursor with `prefix` and at most `maxLength` characters; undefined for
 *  anything else. Callers still check the payload's shape. */
export function decodeVersionedJsonCursor(
  cursor: string,
  prefix: string,
  maxLength: number
): unknown {
  if (cursor.length > maxLength || !cursor.startsWith(prefix)) {
    return undefined
  }
  try {
    return JSON.parse(Buffer.from(cursor.slice(prefix.length), 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
}
