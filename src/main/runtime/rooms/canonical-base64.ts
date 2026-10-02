export function decodeCanonicalBase64(value: string, maxBytes: number): Buffer | null {
  if (!value || value.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    return null
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null
  }
  const decoded = Buffer.from(value, 'base64')
  return decoded.byteLength <= maxBytes && decoded.toString('base64') === value ? decoded : null
}
