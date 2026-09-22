import { sha256 } from '@noble/hashes/sha256'

/** Full sha256 hex, never a slice of the host id and never the id itself: the key names the
 *  directory that holds one host's bundle, two hosts sharing one is the cross-host cache use the
 *  rollback runbook escalates as a security incident, and a host id is free-form text that would
 *  otherwise reach a path. `deriveHostFingerprint` is not this: it hashes the host public key and
 *  truncates to 16 chars for the push gateway. */
export function deriveHostCacheKey(hostId: string): string {
  return Array.from(sha256(new TextEncoder().encode(hostId)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

const HOST_CACHE_KEY_PATTERN = /^[a-f0-9]{64}$/

/** The store checks every key it is handed, so a caller passing a raw host id cannot build a path. */
export function isHostCacheKey(value: string): boolean {
  return HOST_CACHE_KEY_PATTERN.test(value)
}
