export function formatBase64PayloadByteCount(base64: string): string {
  try {
    return `${Buffer.byteLength(base64, 'base64')} bytes`
  } catch {
    return `${Math.floor((base64.length * 3) / 4)} bytes`
  }
}
