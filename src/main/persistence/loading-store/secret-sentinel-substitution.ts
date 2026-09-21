import { createHash } from 'node:crypto'
import { escapeRegex } from '../../../shared/string-utils'

export type SecretSentinelSubstitution = {
  /** The `orca-secret-slot-<uuid>` placeholder standing in the serialized state. */
  sentinel: string
  /** What the on-disk payload gets: the ciphertext. */
  blob: string
  /** What the guard hash gets: a value stable across non-deterministic encryption. */
  hashValue: string
}

/**
 * Replace every secret sentinel in `serialized` in ONE pass, producing the on-disk bytes and the
 * guard hash from the same encoded segments.
 *
 * Why not the obvious `payload.replace(...)` / `hashInput.replace(...)` loop it replaces: each
 * `String.replace` returns a rope that the *next* `replace` has to flatten before it can search, so
 * N sentinels cost 2N-1 flattened copies of the whole multi-MB state, plus one more per side when
 * `hash.update` and the file write finally consume them. Measured on a 4.65 MB store with three
 * sentinels: 7 full-state string allocations, 62 MB of V8 heap, 27 MB of it in large_object_space.
 *
 * Here the state is walked once, each literal run is UTF-8 encoded exactly once, and those same
 * buffers feed both the payload and the hash — 1 full-state string, 1 encode.
 *
 * Byte-for-byte identical output to the loop: both sides read the sentinel in its JSON-escaped
 * form, the replacements are the JSON-escaped `blob`/`hashValue`, and the hash sees the same byte
 * sequence it saw when it was handed one concatenated string.
 */
export function applySecretSentinelSubstitutions(
  serialized: string,
  substitutions: readonly SecretSentinelSubstitution[],
  degradedPrefix: string
): { payload: Buffer; stateHash: string } {
  const hash = createHash('sha1').update(degradedPrefix)
  if (substitutions.length === 0) {
    const payload = Buffer.from(serialized, 'utf8')
    return { payload, stateHash: hash.update(payload).digest('hex') }
  }

  const replacementBySentinel = new Map<string, { blob: Buffer; hashValue: Buffer }>()
  const alternatives: string[] = []
  for (const { sentinel, blob, hashValue } of substitutions) {
    // Preserved from the loop this replaces: both the search key and the replacements are the
    // JSON-escaped forms, because that is what `serialized` actually contains.
    const escapedSentinel = JSON.stringify(sentinel).slice(1, -1)
    if (replacementBySentinel.has(escapedSentinel)) {
      continue
    }
    alternatives.push(escapeRegex(escapedSentinel))
    replacementBySentinel.set(escapedSentinel, {
      blob: Buffer.from(JSON.stringify(blob).slice(1, -1), 'utf8'),
      hashValue: Buffer.from(JSON.stringify(hashValue).slice(1, -1), 'utf8')
    })
  }

  // Global, though a sentinel is a UUID minted after the state was assembled and so occurs exactly
  // once: a single pass that substitutes every occurrence cannot leave one behind on disk.
  const pattern = new RegExp(alternatives.join('|'), 'g')
  const chunks: Buffer[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(serialized)) !== null) {
    // Non-null: the alternation is built from exactly the map's keys.
    const replacement = replacementBySentinel.get(match[0])!
    // A sliced substring, so this does not copy the state; the encode below is its only pass.
    const literal = Buffer.from(serialized.slice(cursor, match.index), 'utf8')
    chunks.push(literal, replacement.blob)
    hash.update(literal)
    hash.update(replacement.hashValue)
    cursor = match.index + match[0].length
  }
  const tail = Buffer.from(serialized.slice(cursor), 'utf8')
  chunks.push(tail)
  hash.update(tail)

  return { payload: Buffer.concat(chunks), stateHash: hash.digest('hex') }
}
