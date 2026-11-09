import { sha256 } from '@noble/hashes/sha256'

// Hash the full free-form host id to prevent path injection and cross-host cache reuse; push fingerprints instead hash the public key and truncate, so cannot substitute.
export function deriveHostCacheKey(hostId: string): string {
  return Array.from(sha256(new TextEncoder().encode(hostId)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

const HOST_CACHE_KEY_PATTERN = /^[a-f0-9]{64}$/

// Validate every store key so raw host ids never reach cache paths.
export function isHostCacheKey(value: string): boolean {
  return HOST_CACHE_KEY_PATTERN.test(value)
}
