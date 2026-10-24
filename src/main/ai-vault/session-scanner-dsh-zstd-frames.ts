import * as zlib from 'node:zlib'

// DSH appends one independent zstd frame per write batch, and
// `zstdDecompressSync` stops after the first frame, so the file is split into
// frames here and each one is decompressed on its own.

const ZSTD_FRAME_MAGIC = 0xfd2fb528
// Skippable frames use magics 0x184D2A50..0x184D2A5F; the low nibble is free.
const ZSTD_SKIPPABLE_MAGIC_MASK = 0xfffffff0
const ZSTD_SKIPPABLE_MAGIC = 0x184d2a50

const MAGIC_BYTES = 4
const FRAME_HEADER_DESCRIPTOR_BYTES = 1
const BLOCK_HEADER_BYTES = 3
const CONTENT_CHECKSUM_BYTES = 4
const SKIPPABLE_SIZE_BYTES = 4
const RLE_BLOCK_TYPE = 1
const RLE_BLOCK_PAYLOAD_BYTES = 1
const DICTIONARY_ID_BYTES = [0, 1, 2, 4] as const

/** Byte length of the frame header after the descriptor byte, per RFC 8878 §3.1.1.1. */
function frameHeaderTailBytes(descriptor: number): number {
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 0x20) !== 0
  const windowDescriptorBytes = singleSegment ? 0 : 1
  const dictionaryIdBytes = DICTIONARY_ID_BYTES[descriptor & 0x03]
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
  return windowDescriptorBytes + dictionaryIdBytes + contentSizeBytes
}

/** End offset of the zstd frame starting at `start`, or null when the frame is incomplete. */
function zstdFrameEnd(bytes: Buffer, start: number): number | null {
  let offset = start + MAGIC_BYTES
  if (offset + FRAME_HEADER_DESCRIPTOR_BYTES > bytes.length) {
    return null
  }
  const descriptor = bytes[offset]
  offset += FRAME_HEADER_DESCRIPTOR_BYTES + frameHeaderTailBytes(descriptor)

  for (;;) {
    if (offset + BLOCK_HEADER_BYTES > bytes.length) {
      return null
    }
    const blockHeader = bytes.readUIntLE(offset, BLOCK_HEADER_BYTES)
    offset += BLOCK_HEADER_BYTES
    const isLastBlock = (blockHeader & 1) !== 0
    const blockType = (blockHeader >>> 1) & 0x03
    const blockSize = blockHeader >>> 3
    offset += blockType === RLE_BLOCK_TYPE ? RLE_BLOCK_PAYLOAD_BYTES : blockSize
    if (offset > bytes.length) {
      return null
    }
    if (isLastBlock) {
      break
    }
  }

  const hasContentChecksum = (descriptor & 0x04) !== 0
  if (hasContentChecksum) {
    offset += CONTENT_CHECKSUM_BYTES
  }
  return offset <= bytes.length ? offset : null
}

/**
 * Yield each complete zstd frame in `bytes`, skipping skippable frames.
 *
 * A trailing frame that ends early is a batch the writer is still flushing, so
 * it ends the walk instead of failing it. Bytes that are not a frame at all do
 * throw: that file is not a zstd stream.
 */
export function* zstdFrames(bytes: Buffer): Generator<Buffer> {
  let offset = 0
  while (offset + MAGIC_BYTES <= bytes.length) {
    const magic = bytes.readUInt32LE(offset)
    if ((magic & ZSTD_SKIPPABLE_MAGIC_MASK) >>> 0 === ZSTD_SKIPPABLE_MAGIC) {
      if (offset + MAGIC_BYTES + SKIPPABLE_SIZE_BYTES > bytes.length) {
        return
      }
      offset += MAGIC_BYTES + SKIPPABLE_SIZE_BYTES + bytes.readUInt32LE(offset + MAGIC_BYTES)
      continue
    }
    if (magic !== ZSTD_FRAME_MAGIC) {
      throw new Error(`Not a zstd frame at byte ${offset}`)
    }
    const end = zstdFrameEnd(bytes, offset)
    if (end === null) {
      return
    }
    yield bytes.subarray(offset, end)
    offset = end
  }
}

/** Decompress every complete frame of a multi-frame zstd file, in order. */
export function* decompressZstdFrames(bytes: Buffer): Generator<Buffer> {
  // Why: zstd landed in Node 22.15; an older runtime reports one scan issue
  // instead of crashing the scanner.
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error('This runtime cannot decompress zstd session files')
  }
  for (const frame of zstdFrames(bytes)) {
    yield zlib.zstdDecompressSync(frame)
  }
}
