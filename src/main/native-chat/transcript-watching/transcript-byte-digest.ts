import { createHash } from 'node:crypto'

export const MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES = 2 * 1024 * 1024

export function transcriptLineDigest(offset: number, bytes: Buffer, length = bytes.length): bigint {
  const position = Buffer.allocUnsafe(8)
  position.writeBigUInt64LE(BigInt(offset))
  const hash = createHash('sha1').update(position)
  if (length > MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES) {
    const size = Buffer.allocUnsafe(8)
    size.writeBigUInt64LE(BigInt(length))
    hash.update(size)
  } else {
    hash.update(bytes.subarray(0, bytes.at(-1) === 0x0d ? bytes.length - 1 : bytes.length))
  }
  return hash.digest().readBigUInt64LE(0)
}
