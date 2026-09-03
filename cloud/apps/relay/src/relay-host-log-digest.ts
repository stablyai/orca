import { createHash } from 'node:crypto'

// Store-level 503s were previously silent; the digest keeps per-host log
// correlation possible without emitting the raw relay host id.
export function relayHostLogDigest(relayHostId: string): string {
  return createHash('sha256').update(relayHostId).digest('hex').slice(0, 12)
}
