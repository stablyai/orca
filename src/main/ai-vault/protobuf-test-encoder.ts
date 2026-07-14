// Minimal protobuf wire-format encoder shared by the tests and fixtures that
// build Antigravity-style protobuf blobs. Mirrors the two wire types the reader
// (protobuf-wire-reader.ts) decodes: varint (0) and length-delimited (2).
// Kept separate from any single test file so the encoder is not duplicated.

export function encodeVarint(value: number): number[] {
  // Guard non-representable inputs: negatives/fractions produce wrong bytes and
  // Infinity/NaN would loop forever. Arithmetic (% / Math.floor) rather than
  // bitwise so values above 2^31 aren't truncated to signed 32-bit.
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`encodeVarint expects a non-negative safe integer, got ${value}`)
  }
  const out: number[] = []
  let remaining = value
  do {
    let byte = remaining % 128
    remaining = Math.floor(remaining / 128)
    if (remaining > 0) {
      byte += 0x80
    }
    out.push(byte)
  } while (remaining > 0)
  return out
}

export function tag(field: number, wire: number): number[] {
  // Arithmetic, not `field << 3`: the shift truncates to signed 32-bit and
  // emits wrong bytes for field numbers at the top of the protobuf range.
  return encodeVarint(field * 8 + wire)
}

export function varintField(field: number, value: number): number[] {
  return [...tag(field, 0), ...encodeVarint(value)]
}

export function stringField(field: number, value: string): number[] {
  const bytes = [...new TextEncoder().encode(value)]
  return [...tag(field, 2), ...encodeVarint(bytes.length), ...bytes]
}

// Length-delimited field from raw bytes — a nested message, or (in reader
// tests) an intentionally non-UTF-8 payload.
export function messageField(field: number, sub: readonly number[]): number[] {
  return [...tag(field, 2), ...encodeVarint(sub.length), ...sub]
}
