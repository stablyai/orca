import * as ExpoCrypto from 'expo-crypto'

/**
 * A v4 UUID from a secure source. `crypto.randomUUID` is missing on Hermes and on the page under the
 * iOS shell's custom scheme (not a secure context), so the fallback builds one from the platform's
 * own random bytes, never `Math.random`.
 */
export function randomV4Uuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  const bytes = ExpoCrypto.getRandomBytes(16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
