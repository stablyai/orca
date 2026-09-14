// Bounds-checked primitives for walking a minidump.
//
// Split from minidump-crash-signature so the byte-level layout knowledge
// (header, stream directory, MINIDUMP_LOCATION_DESCRIPTOR, the two string
// encodings) stays separate from what Crashpad puts in those structures.
//
// Every accessor returns null past the end of the buffer: a truncated or
// corrupt dump must degrade, not throw, or it takes crash reporting down with it.

export const MINIDUMP_SIGNATURE = 0x504d444d // 'MDMP' little-endian
export const MINIDUMP_HEADER_SIZE = 32
const DIRECTORY_ENTRY_SIZE = 12
// A dump claiming an absurd stream count is corrupt; cap before iterating.
const MAX_STREAMS = 4_096
export const MAX_ANNOTATION_VALUE_BYTES = 8_192
// Cap for Crashpad's per-module info list; the MINIDUMP_MODULE_LIST is capped separately.
export const MAX_MODULES = 1_024

export type LocationDescriptor = {
  readonly size: number
  readonly rva: number
}

export class MinidumpView {
  constructor(private readonly buf: Buffer) {}

  get byteLength(): number {
    return this.buf.length
  }

  u32(offset: number): number | null {
    if (offset < 0 || offset + 4 > this.buf.length) {
      return null
    }
    return this.buf.readUInt32LE(offset)
  }

  u16(offset: number): number | null {
    if (offset < 0 || offset + 2 > this.buf.length) {
      return null
    }
    return this.buf.readUInt16LE(offset)
  }

  u64(offset: number): bigint | null {
    if (offset < 0 || offset + 8 > this.buf.length) {
      return null
    }
    return this.buf.readBigUInt64LE(offset)
  }

  location(offset: number): LocationDescriptor | null {
    const size = this.u32(offset)
    const rva = this.u32(offset + 4)
    if (size === null || rva === null) {
      return null
    }
    // A zero rva means "absent", which is normal for optional sub-structures.
    if (rva === 0 || rva >= this.buf.length) {
      return null
    }
    return { size, rva }
  }

  /** MinidumpUTF8String: u32 byte length, then NUL-terminated UTF-8. */
  utf8String(rva: number, maxBytes = MAX_ANNOTATION_VALUE_BYTES): string | null {
    return this.byteArray(rva, maxBytes)?.toString('utf8') ?? null
  }

  /** MINIDUMP_STRING: u32 byte length, then UTF-16LE. Used for module names. */
  utf16String(rva: number, maxBytes = MAX_ANNOTATION_VALUE_BYTES): string | null {
    const length = this.u32(rva)
    if (length === null || length > maxBytes || length % 2 !== 0) {
      return null
    }
    const start = rva + 4
    if (start + length > this.buf.length) {
      return null
    }
    return this.buf.toString('utf16le', start, start + length)
  }

  bytes(location: LocationDescriptor, maxBytes = MAX_ANNOTATION_VALUE_BYTES): Buffer | null {
    if (location.size > maxBytes || location.rva + location.size > this.buf.length) {
      return null
    }
    return this.buf.subarray(location.rva, location.rva + location.size)
  }

  /** MinidumpByteArray: u32 byte length, then the bytes. */
  byteArray(rva: number, maxBytes = MAX_ANNOTATION_VALUE_BYTES): Buffer | null {
    const length = this.u32(rva)
    if (length === null || length > maxBytes) {
      return null
    }
    return this.bytes({ size: length, rva: rva + 4 }, maxBytes)
  }
}

export function isMinidump(dump: Buffer): boolean {
  return dump.length >= MINIDUMP_HEADER_SIZE && dump.readUInt32LE(0) === MINIDUMP_SIGNATURE
}

/** Locates a stream by type in the header's directory, or null if absent. */
export function findStream(view: MinidumpView, streamType: number): LocationDescriptor | null {
  const streamCount = view.u32(8)
  const directoryRva = view.u32(12)
  if (streamCount === null || directoryRva === null || streamCount > MAX_STREAMS) {
    return null
  }
  for (let index = 0; index < streamCount; index += 1) {
    const entry = directoryRva + index * DIRECTORY_ENTRY_SIZE
    const type = view.u32(entry)
    if (type === null) {
      return null
    }
    if (type !== streamType) {
      continue
    }
    const size = view.u32(entry + 4)
    const rva = view.u32(entry + 8)
    if (size === null || rva === null || rva === 0 || rva >= view.byteLength) {
      return null
    }
    return { size, rva }
  }
  return null
}
