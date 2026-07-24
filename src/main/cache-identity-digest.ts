import { createHash } from 'node:crypto'

/** Fixed-size identity for long-lived maps whose source fields can be arbitrarily large. */
export function cacheIdentityDigest(parts: readonly string[]): string {
  const digest = createHash('sha256')
  for (const part of parts) {
    digest.update(`${part.length}:`)
    digest.update(part)
  }
  return digest.digest('base64url')
}
