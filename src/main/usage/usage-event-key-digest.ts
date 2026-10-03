import { hash } from 'node:crypto'

// Why: raw ownership keys (~92 B each, millions on a long history) made the
// persisted cache 200+ MB and its sync JSON.stringify froze the main process.
// Dedup only needs key equality, so fixed-width digests packed into one string
// per file keep the same ownership semantics at a fraction of the bytes.

/** base64url chars per digest: 16 × 6 = 96 bits, so the birthday bound for a
 *  collision is ~2^48 keys — far beyond any local usage history. */
export const USAGE_EVENT_KEY_DIGEST_LENGTH = 16

export function digestUsageEventKey(eventKey: string): string {
  return hash('sha256', eventKey, 'base64url').slice(0, USAGE_EVENT_KEY_DIGEST_LENGTH)
}

export function packUsageEventKeyDigests(digests: Iterable<string>): string {
  return Array.from(digests).join('')
}

/** A value persisted before packing shipped (or by a corrupt cache) fails this,
 *  so the file is reparsed rather than trusted. */
export function isPackedUsageEventKeyDigests(value: unknown): value is string {
  return typeof value === 'string' && value.length % USAGE_EVENT_KEY_DIGEST_LENGTH === 0
}

export function countPackedUsageEventKeyDigests(packed: string): number {
  return packed.length / USAGE_EVENT_KEY_DIGEST_LENGTH
}

export function* unpackUsageEventKeyDigests(packed: string): Generator<string> {
  for (let offset = 0; offset < packed.length; offset += USAGE_EVENT_KEY_DIGEST_LENGTH) {
    yield packed.slice(offset, offset + USAGE_EVENT_KEY_DIGEST_LENGTH)
  }
}
