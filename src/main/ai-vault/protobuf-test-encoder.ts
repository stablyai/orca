// Minimal protobuf wire-format encoder shared by the tests and fixtures that
// build Antigravity-style protobuf blobs. Mirrors the two wire types the reader
// (protobuf-wire-reader.ts) decodes: varint (0) and length-delimited (2).
// Kept separate from any single test file so the encoder is not duplicated.

export function encodeVarint(value: number): number[] {
  const out: number[] = []
  let remaining = value
  do {
    let byte = remaining & 0x7f
    remaining = Math.floor(remaining / 128)
    if (remaining > 0) {
      byte |= 0x80
    }
    out.push(byte)
  } while (remaining > 0)
  return out
}

export function tag(field: number, wire: number): number[] {
  return encodeVarint((field << 3) | wire)
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
