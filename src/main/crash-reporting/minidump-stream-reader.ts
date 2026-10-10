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

export type MinidumpSource = {
  readonly byteLength: number
  read(offset: number, size: number): Promise<Buffer>
}

export class MinidumpView {
  constructor(private readonly source: MinidumpSource) {}

  get byteLength(): number {
    return this.source.byteLength
  }

  async u32(offset: number): Promise<number | null> {
    if (offset < 0 || offset + 4 > this.source.byteLength) {
      return null
    }
    const bytes = await this.source.read(offset, 4)
    return bytes.length === 4 ? bytes.readUInt32LE(0) : null
  }

  async u16(offset: number): Promise<number | null> {
    if (offset < 0 || offset + 2 > this.source.byteLength) {
      return null
    }
    const bytes = await this.source.read(offset, 2)
    return bytes.length === 2 ? bytes.readUInt16LE(0) : null
  }

  async u64(offset: number): Promise<bigint | null> {
    if (offset < 0 || offset + 8 > this.source.byteLength) {
      return null
    }
    const bytes = await this.source.read(offset, 8)
    return bytes.length === 8 ? bytes.readBigUInt64LE(0) : null
  }

  async location(offset: number): Promise<LocationDescriptor | null> {
    const size = await this.u32(offset)
    const rva = await this.u32(offset + 4)
    if (size === null || rva === null) {
      return null
    }
    // A zero rva means "absent", which is normal for optional sub-structures.
    if (rva === 0 || rva >= this.source.byteLength) {
      return null
    }
    return { size, rva }
  }

  /** MinidumpUTF8String: u32 byte length, then NUL-terminated UTF-8. */
  async utf8String(rva: number, maxBytes = MAX_ANNOTATION_VALUE_BYTES): Promise<string | null> {
    return (await this.byteArray(rva, maxBytes))?.toString('utf8') ?? null
  }

  /** MINIDUMP_STRING: u32 byte length, then UTF-16LE. Used for module names. */
  async utf16String(rva: number, maxBytes = MAX_ANNOTATION_VALUE_BYTES): Promise<string | null> {
    const length = await this.u32(rva)
    if (length === null || length > maxBytes || length % 2 !== 0) {
      return null
    }
    const start = rva + 4
    if (start + length > this.source.byteLength) {
      return null
    }
    const bytes = await this.source.read(start, length)
    return bytes.length === length ? bytes.toString('utf16le') : null
  }

  async bytes(
    location: LocationDescriptor,
    maxBytes = MAX_ANNOTATION_VALUE_BYTES
  ): Promise<Buffer | null> {
    if (location.size > maxBytes || location.rva + location.size > this.source.byteLength) {
      return null
    }
    const bytes = await this.source.read(location.rva, location.size)
    return bytes.length === location.size ? bytes : null
  }

  /** MinidumpByteArray: u32 byte length, then the bytes. */
  async byteArray(rva: number, maxBytes = MAX_ANNOTATION_VALUE_BYTES): Promise<Buffer | null> {
    const length = await this.u32(rva)
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
export async function findStream(
  view: MinidumpView,
  streamType: number
): Promise<LocationDescriptor | null> {
  const streamCount = await view.u32(8)
  const directoryRva = await view.u32(12)
  if (streamCount === null || directoryRva === null || streamCount > MAX_STREAMS) {
    return null
  }
  for (let index = 0; index < streamCount; index += 1) {
    const entry = directoryRva + index * DIRECTORY_ENTRY_SIZE
    const type = await view.u32(entry)
    if (type === null) {
      return null
    }
    if (type !== streamType) {
      continue
    }
    const size = await view.u32(entry + 4)
    const rva = await view.u32(entry + 8)
    if (size === null || rva === null || rva === 0 || rva >= view.byteLength) {
      return null
    }
    return { size, rva }
  }
  return null
}
