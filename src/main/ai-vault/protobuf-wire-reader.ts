// Minimal, defensive protobuf wire-format reader. Antigravity stores its CLI
// session transcripts as protobuf blobs inside a SQLite DB, and Orca only needs
// a handful of fields (message text, step type, timestamps). This reads those
// fields by number and skips everything else; unknown fields and malformed
// tails are ignored rather than thrown, matching protobuf's forward-compatible
// wire model. Only wire types 0 (varint), 1 (64-bit), 2 (length-delimited),
// and 5 (32-bit) are handled — legacy group wire types stop the scan.

type WireValue = { wire: 0; varint: number } | { wire: 1 | 2 | 5; bytes: Uint8Array }

type VarintRead = { value: number; next: number }

// Reads a base-128 varint. Uses multiplication rather than `<<` because JS
// bit-shifts are 32-bit and would corrupt values past 2^31 (timestamps, ids).
function readVarint(buf: Uint8Array, offset: number): VarintRead | null {
  let result = 0
  let multiplier = 1
  let pos = offset
  while (pos < buf.length) {
    const byte = buf[pos]
    pos += 1
    result += (byte & 0x7f) * multiplier
    if ((byte & 0x80) === 0) {
      return { value: result, next: pos }
    }
    multiplier *= 128
    if (multiplier > Number.MAX_SAFE_INTEGER) {
      return null
    }
  }
  return null
}

function* scanFields(buf: Uint8Array): Generator<{ field: number; value: WireValue }> {
  let pos = 0
  while (pos < buf.length) {
    const tag = readVarint(buf, pos)
    if (!tag) {
      return
    }
    pos = tag.next
    // Avoid 32-bit `&`/`>>` on the tag so large field numbers stay intact.
    const field = Math.floor(tag.value / 8)
    const wire = tag.value % 8
    if (wire === 0) {
      const varint = readVarint(buf, pos)
      if (!varint) {
        return
      }
      pos = varint.next
      yield { field, value: { wire: 0, varint: varint.value } }
    } else if (wire === 2) {
      const len = readVarint(buf, pos)
      if (!len) {
        return
      }
      pos = len.next
      if (pos + len.value > buf.length) {
        return
      }
      yield { field, value: { wire: 2, bytes: buf.subarray(pos, pos + len.value) } }
      pos += len.value
    } else if (wire === 1) {
      if (pos + 8 > buf.length) {
        return
      }
      yield { field, value: { wire: 1, bytes: buf.subarray(pos, pos + 8) } }
      pos += 8
    } else if (wire === 5) {
      if (pos + 4 > buf.length) {
        return
      }
      yield { field, value: { wire: 5, bytes: buf.subarray(pos, pos + 4) } }
      pos += 4
    } else {
      // Wire types 3/4 are deprecated groups; stop rather than misparse.
      return
    }
  }
}

function firstField(buf: Uint8Array, fieldNumber: number): WireValue | null {
  for (const entry of scanFields(buf)) {
    if (entry.field === fieldNumber) {
      return entry.value
    }
  }
  return null
}

/** First varint value for `fieldNumber`, or null if absent/other wire type. */
export function pbVarint(buf: Uint8Array, fieldNumber: number): number | null {
  const value = firstField(buf, fieldNumber)
  return value && value.wire === 0 ? value.varint : null
}

/** First length-delimited payload (nested message / string / bytes) bytes. */
export function pbMessage(buf: Uint8Array, fieldNumber: number): Uint8Array | null {
  const value = firstField(buf, fieldNumber)
  return value && value.wire === 2 ? value.bytes : null
}

/** First length-delimited field decoded as UTF-8 text. */
export function pbString(buf: Uint8Array, fieldNumber: number): string | null {
  const bytes = pbMessage(buf, fieldNumber)
  return bytes ? new TextDecoder().decode(bytes) : null
}

/** Walk nested messages by field number, e.g. `pbPath(step, [5, 1])`. */
export function pbPath(buf: Uint8Array, path: readonly number[]): Uint8Array | null {
  let current: Uint8Array | null = buf
  for (const fieldNumber of path) {
    if (!current) {
      return null
    }
    current = pbMessage(current, fieldNumber)
  }
  return current
}

function decodeStrictUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/**
 * Recursively search every length-delimited field for a UTF-8 string matching
 * `predicate`. Used to locate the Antigravity workspace `file://` URI, whose
 * exact field path inside `trajectory_metadata_blob` varies by CLI version —
 * scanning for the string is resilient to that drift. Non-UTF-8 fields are
 * skipped, and each field is also descended into as a possible nested message.
 */
export function pbFindString(
  buf: Uint8Array,
  predicate: (text: string) => boolean,
  maxDepth = 6
): string | null {
  for (const entry of scanFields(buf)) {
    if (entry.value.wire !== 2) {
      continue
    }
    const text = decodeStrictUtf8(entry.value.bytes)
    if (text !== null && predicate(text)) {
      return text
    }
    if (maxDepth > 0) {
      const nested = pbFindString(entry.value.bytes, predicate, maxDepth - 1)
      if (nested !== null) {
        return nested
      }
    }
  }
  return null
}
