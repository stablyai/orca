import { sha256 } from '@noble/hashes/sha256'

export function mobileWebFileRevision(bytes: Uint8Array): string {
  return Array.from(sha256(bytes), (value) => value.toString(16).padStart(2, '0')).join('')
}
