import { createHash } from 'node:crypto'

// Correlate per-host 503s without logging raw host IDs.
export function relayHostLogDigest(relayHostId: string): string {
  return createHash('sha256').update(relayHostId).digest('hex').slice(0, 12)
}
