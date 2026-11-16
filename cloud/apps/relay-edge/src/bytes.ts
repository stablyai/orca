export function b64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) { binary += String.fromCharCode(byte) }
  return btoa(binary)
}

export function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) { bytes[i] = binary.charCodeAt(i) }
  return bytes
}

export async function sha256B64url(bytes: Uint8Array): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
}

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, data))
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) { return false }
  let diff = 0
  for (let i = 0; i < a.length; i++) { diff |= a.charCodeAt(i) ^ b.charCodeAt(i) }
  return diff === 0
}

// As the cells' ws maxPayload: a frame larger than this closes the sender with 1009.
export const MESSAGE_TOO_BIG = 1009
export const CONTROL_MAX_FRAME_BYTES = 1024 * 1024

// UTF-8 size of a frame without encoding it when it is plainly under the limit.
export function frameOver(message: string | ArrayBuffer, limit: number): boolean {
  if (typeof message !== 'string') { return message.byteLength > limit }
  if (message.length * 3 <= limit) { return false }
  return message.length > limit || new TextEncoder().encode(message).byteLength > limit
}
