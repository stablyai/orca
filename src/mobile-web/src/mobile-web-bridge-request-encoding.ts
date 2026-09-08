export function encodedMobileWebBridgeValueByteLength(value: unknown): number {
  try {
    const encoded = JSON.stringify(value)
    return encoded === undefined
      ? Number.POSITIVE_INFINITY
      : new TextEncoder().encode(encoded).byteLength
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

export function secureMobileWebBridgeRequestId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let value = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    value += base64UrlCharacter(first >> 2)
    value += base64UrlCharacter(((first & 3) << 4) | ((second ?? 0) >> 4))
    if (second !== undefined) {
      value += base64UrlCharacter(((second & 15) << 2) | ((third ?? 0) >> 6))
    }
    if (third !== undefined) {
      value += base64UrlCharacter(third & 63)
    }
  }
  return value
}

function base64UrlCharacter(value: number): string {
  return 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[value] ?? ''
}
