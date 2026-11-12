// Rejects the many base64 spellings of the same bytes: a non-canonical
// encoding would change the transcript the host signs without changing the key.
export function decodeCanonicalBase64(value: string, expectedBytes: number): Buffer | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null
  const decoded = Buffer.from(value, 'base64')
  return decoded.byteLength === expectedBytes && decoded.toString('base64') === value
    ? decoded
    : null
}
